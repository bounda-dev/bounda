import { describe, expect, it } from "vitest";
import type { PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { generatePersonalKey } from "./crypto.ts";
import { defineKeyWrapper, isKeyWrapperDefinition, type KeyWrapper } from "./key-wrapper.ts";
import {
  buildPersonalKeyWrapping,
  createPersonalKeyWrapping,
  UNWRAPPED_KEY_TTL_MS,
  UNWRAPPED_KEYS_KEPT,
} from "./wrapped-keys.ts";

interface FakeWrapper extends KeyWrapper {
  readonly unwrapped: string[];
}

// Flips every byte with the kid's length, so each kid wraps differently and wrapping is reversible.
const fakeWrapper = (kid: string, previous: readonly string[] = []): FakeWrapper => {
  const unwrapped: string[] = [];
  const flip = (bytes: Uint8Array, under: string) => bytes.map((byte) => byte ^ under.length);
  return {
    kid,
    previous,
    unwrapped,
    wrap: async (key) => flip(key, kid),
    unwrap: async ({ kid: under, wrapped }) => {
      unwrapped.push(under);
      return flip(wrapped, under);
    },
  };
};

const clock = createFixedClock();

const keyStore = async (): Promise<PersonalKeyStore> =>
  (await memory().createStorage()).personalKeys;

describe("createPersonalKeyWrapping", () => {
  it("stores a key wrapped under the wrapper's kid, with the fingerprint of the raw key", async () => {
    const store = await keyStore();
    const keys = createPersonalKeyWrapping({ clock, wrapper: fakeWrapper("kid-1") }).over(store);
    const key = await generatePersonalKey();
    expect(await keys.add("c-1", key)).toEqual(key);
    const stored = await store.get("c-1");
    expect(stored).toEqual({ key: expect.any(String), fingerprint: key.fingerprint, kid: "kid-1" });
    expect(stored?.key).not.toBe(key.key);
    expect(await keys.get("c-1")).toEqual(key);
  });

  it("answers an add with the key another writer stored first, unwrapped", async () => {
    const store = await keyStore();
    const wrapping = createPersonalKeyWrapping({ clock, wrapper: fakeWrapper("kid-1") });
    const first = await generatePersonalKey();
    await wrapping.over(store).add("c-1", first);
    expect(await wrapping.over(store).add("c-1", await generatePersonalKey())).toEqual(first);
  });

  it("unwraps a key once, whatever number of reads, and never answers from it once the row is gone", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = createPersonalKeyWrapping({ clock, wrapper }).over(store);
    const key = await generatePersonalKey();
    await keys.add("c-1", key);
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
    expect(await keys.get("c-1")).toEqual(key);
    expect(await keys.get("c-1")).toEqual(key);
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
    // Another instance forgets the person: the cache still holds the key, the row is gone.
    expect(await store.remove("c-1")).toBe(true);
    expect(await keys.get("c-1")).toBeNull();
  });

  it("drops the unwrapped key of a person it forgets", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = createPersonalKeyWrapping({ clock, wrapper }).over(store);
    const key = await generatePersonalKey();
    await keys.add("c-1", key);
    const stored = await store.get("c-1");
    expect(await keys.remove("c-1")).toBe(true);
    // The same row put back, as a restore would: unwrapped again, so the cache had let it go.
    await store.add("c-1", stored ?? key);
    wrapper.unwrapped.length = 0;
    expect(await keys.get("c-1")).toEqual(key);
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
    expect(await keys.remove("c-2")).toBe(false);
    // Read, not added, by this instance: the same.
    expect(await keys.remove("c-1")).toBe(true);
    await store.add("c-1", stored ?? key);
    expect(await keys.get("c-1")).toEqual(key);
    expect(wrapper.unwrapped).toEqual(["kid-1", "kid-1"]);
  });

  it("unwraps once for reads made at the same time", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const key = await generatePersonalKey();
    await createPersonalKeyWrapping({ clock, wrapper }).over(store).add("c-1", key);
    const keys = createPersonalKeyWrapping({ clock, wrapper }).over(store);
    wrapper.unwrapped.length = 0;
    expect(await Promise.all([keys.get("c-1"), keys.get("c-1")])).toEqual([key, key]);
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
  });

  it("unwraps again a key whose unwrapping failed", async () => {
    const store = await keyStore();
    const key = await generatePersonalKey();
    await createPersonalKeyWrapping({ clock, wrapper: fakeWrapper("kid-1") })
      .over(store)
      .add("c-1", key);
    let fail = true;
    const flaky: KeyWrapper = {
      ...fakeWrapper("kid-1"),
      unwrap: async (args) => {
        if (fail) throw new Error("KMS unavailable");
        return fakeWrapper("kid-1").unwrap(args);
      },
    };
    const keys = createPersonalKeyWrapping({ clock, wrapper: flaky }).over(store);
    await expect(keys.get("c-1")).rejects.toThrow("KMS unavailable");
    fail = false;
    expect(await keys.get("c-1")).toEqual(key);
  });

  it("keeps UNWRAPPED_KEYS_KEPT keys by default", () => {
    expect(UNWRAPPED_KEYS_KEPT).toBe(10_000);
  });

  it("keeps at most as many keys as it is told, the least recently read out first", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = createPersonalKeyWrapping({ clock, wrapper, keep: 3 }).over(store);
    const persons = Array.from({ length: 4 }, (_, index) => `c-${index}`);
    for (const person of persons) await keys.add(person, await generatePersonalKey());
    const reads = () => wrapper.unwrapped.length;
    let before = reads();
    // The first was the oldest, so it went out when the last came in.
    await keys.get("c-0");
    expect(reads()).toBe(before + 1);
    // Reading `c-2` makes it recent, so the next eviction takes `c-3`, not it.
    before = reads();
    await keys.get("c-2");
    expect(reads()).toBe(before);
    await keys.add("c-new", await generatePersonalKey());
    before = reads();
    await keys.get("c-2");
    expect(reads()).toBe(before);
    await keys.get("c-3");
    expect(reads()).toBe(before + 1);
  });

  it("keeps an unwrapped key UNWRAPPED_KEY_TTL_MS by default, five minutes", async () => {
    expect(UNWRAPPED_KEY_TTL_MS).toBe(300_000);
    const store = await keyStore();
    const timed = createFixedClock();
    const wrapper = fakeWrapper("kid-1");
    const keys = createPersonalKeyWrapping({ clock: timed, wrapper }).over(store);
    await keys.add("c-1", await generatePersonalKey());
    timed.advance(UNWRAPPED_KEY_TTL_MS - 1);
    await keys.get("c-1");
    expect(wrapper.unwrapped).toHaveLength(1);
    timed.advance(1);
    await keys.get("c-1");
    expect(wrapper.unwrapped).toHaveLength(2);
  });

  it("drops an unwrapped key its time after it was unwrapped, however often it is read, with nothing read meanwhile", async () => {
    const store = await keyStore();
    const timed = createFixedClock();
    const wrapper = fakeWrapper("kid-1");
    const keys = createPersonalKeyWrapping({ clock: timed, wrapper, ttlMs: 1_000 }).over(store);
    const first = await generatePersonalKey();
    await keys.add("c-1", first);
    timed.advance(600);
    await keys.add("c-2", await generatePersonalKey());
    expect(timed.pending()).toBe(1);
    timed.advance(399);
    expect(await keys.get("c-1")).toEqual(first);
    expect(wrapper.unwrapped).toHaveLength(2);
    // Nothing reads: the timer drops the first key when its time is up, then the second.
    timed.advance(1);
    expect(timed.pending()).toBe(1);
    timed.advance(600);
    expect(timed.pending()).toBe(0);
    expect(await keys.get("c-1")).toEqual(first);
    expect(wrapper.unwrapped).toHaveLength(3);
    expect(await keys.remove("c-1")).toBe(true);
    timed.advance(1_000);
    expect(timed.pending()).toBe(0);
  });

  it("unwraps again a key read past its time before the timer dropped it", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const late: typeof clock = { ...createFixedClock(), after: () => () => undefined };
    const keys = createPersonalKeyWrapping({ clock: late, wrapper, ttlMs: 1_000 }).over(store);
    const key = await generatePersonalKey();
    await keys.add("c-1", key);
    late.advance(999);
    await keys.get("c-1");
    expect(wrapper.unwrapped).toHaveLength(1);
    late.advance(1);
    expect(await keys.get("c-1")).toEqual(key);
    expect(wrapper.unwrapped).toHaveLength(2);
  });

  it("puts a key unwrapped again past its time last, so the next one in is not what goes out", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const late: typeof clock = { ...createFixedClock(), after: () => () => undefined };
    const keys = createPersonalKeyWrapping({ clock: late, wrapper, keep: 2, ttlMs: 1_000 }).over(
      store,
    );
    await keys.add("c-1", await generatePersonalKey());
    late.advance(500);
    await keys.add("c-2", await generatePersonalKey());
    late.advance(500);
    await keys.get("c-1");
    expect(wrapper.unwrapped).toHaveLength(3);
    late.advance(100);
    await keys.add("c-3", await generatePersonalKey());
    await keys.get("c-1");
    expect(wrapper.unwrapped).toHaveLength(4);
    await keys.get("c-2");
    expect(wrapper.unwrapped).toHaveLength(5);
  });

  it("keeps a key unwrapped again when an older unwrapping of it fails late", async () => {
    const store = await keyStore();
    const key = await generatePersonalKey();
    await createPersonalKeyWrapping({ clock, wrapper: fakeWrapper("kid-1") })
      .over(store)
      .add("c-1", key);
    let fail: (error: Error) => void = () => undefined;
    let calls = 0;
    const slow: KeyWrapper = {
      ...fakeWrapper("kid-1"),
      unwrap: async (args) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((_, reject) => {
            fail = reject;
          });
        }
        return fakeWrapper("kid-1").unwrap(args);
      },
    };
    const late: typeof clock = { ...createFixedClock(), after: () => () => undefined };
    const keys = createPersonalKeyWrapping({ clock: late, wrapper: slow, ttlMs: 1_000 }).over(
      store,
    );
    const first = keys.get("c-1");
    await new Promise((resolve) => setImmediate(resolve));
    late.advance(1_000);
    expect(await keys.get("c-1")).toEqual(key);
    fail(new Error("KMS timed out"));
    await expect(first).rejects.toThrow("KMS timed out");
    expect(await keys.get("c-1")).toEqual(key);
    expect(calls).toBe(2);
  });

  it("rewraps with a key kept, and keeps none it had to unwrap for it", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1", ["kid-0"]);
    const late: typeof clock = { ...createFixedClock(), after: () => () => undefined };
    const wrapping = createPersonalKeyWrapping({ clock: late, wrapper, ttlMs: 1_000 });
    const keys = wrapping.over(store);
    const key = await generatePersonalKey();
    await keys.add("c-1", key);
    const stored = (await store.get("c-1")) ?? key;
    await wrapping.wrapped(stored);
    expect(wrapper.unwrapped).toHaveLength(1);
    wrapping.drop("c-1");
    wrapping.drop("c-9");
    await wrapping.wrapped(stored);
    await wrapping.wrapped(stored);
    expect(wrapper.unwrapped).toHaveLength(3);
    await keys.get("c-1");
    await keys.get("c-1");
    expect(wrapper.unwrapped).toHaveLength(4);
    late.advance(1_000);
    await wrapping.wrapped(stored);
    expect(wrapper.unwrapped).toHaveLength(5);
  });

  it("takes a key kept from further off than its time allows, after the clock was set back, as expired", async () => {
    const store = await keyStore();
    const timed = createFixedClock(new Date("2026-01-01T01:00:00Z"));
    const wrapper = fakeWrapper("kid-1");
    const keys = createPersonalKeyWrapping({ clock: timed, wrapper, ttlMs: 1_000 }).over(store);
    await keys.add("c-1", await generatePersonalKey());
    timed.set(new Date("2026-01-01T00:00:00Z"));
    await keys.get("c-1");
    expect(wrapper.unwrapped).toHaveLength(2);
  });

  it("drops only the forgotten person's key", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = createPersonalKeyWrapping({ clock, wrapper }).over(store);
    await keys.add("c-1", await generatePersonalKey());
    const kept = await generatePersonalKey();
    await keys.add("c-2", kept);
    await keys.remove("c-1");
    expect(await keys.get("c-2")).toEqual(kept);
    expect(wrapper.unwrapped).toHaveLength(2);
  });

  it("arms its expiry as a background wait, so it never keeps a process alive", async () => {
    const store = await keyStore();
    const options: unknown[] = [];
    const watched: typeof clock = {
      ...createFixedClock(),
      after: (_milliseconds, _callback, given) => {
        options.push(given);
        return () => undefined;
      },
    };
    const keys = createPersonalKeyWrapping({ clock: watched, wrapper: fakeWrapper("kid-1") }).over(
      store,
    );
    await keys.add("c-1", await generatePersonalKey());
    expect(options).toEqual([{ background: true }]);
  });

  it("drops every unwrapped key and its timer when closed", async () => {
    const store = await keyStore();
    const timed = createFixedClock();
    const wrapper = fakeWrapper("kid-1");
    const wrapping = createPersonalKeyWrapping({ clock: timed, wrapper });
    await wrapping.over(store).add("c-1", await generatePersonalKey());
    expect(timed.pending()).toBe(1);
    wrapping.close();
    expect(timed.pending()).toBe(0);
    await wrapping.over(store).get("c-1");
    expect(wrapper.unwrapped).toHaveLength(2);
  });

  it("opens keys kept unwrapped, from before a wrapper was set, as they are", async () => {
    const store = await keyStore();
    const key = await generatePersonalKey();
    await store.add("c-1", key);
    const wrapper = fakeWrapper("kid-1");
    expect(await createPersonalKeyWrapping({ clock, wrapper }).over(store).get("c-1")).toEqual(key);
    expect(wrapper.unwrapped).toEqual([]);
  });

  it("unwraps a key under a previous kid, and rewraps it under the current one", async () => {
    const store = await keyStore();
    const key = await generatePersonalKey();
    await createPersonalKeyWrapping({ clock, wrapper: fakeWrapper("old") })
      .over(store)
      .add("c-1", key);
    const stored = await store.get("c-1");
    const wrapping = createPersonalKeyWrapping({ clock, wrapper: fakeWrapper("current", ["old"]) });
    expect(await wrapping.over(store).get("c-1")).toEqual(key);
    const rewrapped = await wrapping.wrapped(stored ?? key);
    expect(rewrapped.kid).toBe("current");
    expect(rewrapped.key).not.toBe(stored?.key);
    expect(await wrapping.unwrapped({ ...rewrapped, fingerprint: key.fingerprint }, "c-1")).toEqual(
      key,
    );
  });

  it("keeps keys as they are without a wrapper", async () => {
    const store = await keyStore();
    const wrapping = createPersonalKeyWrapping({ clock, wrapper: null });
    const key = await generatePersonalKey();
    await wrapping.over(store).add("c-1", key);
    expect(await store.get("c-1")).toEqual(key);
    expect(await wrapping.wrapped(key)).toEqual({ key: key.key, kid: null });
  });

  it("refuses a wrapped key without a wrapper, under an unknown kid, or unwrapping to another key", async () => {
    const store = await keyStore();
    const key = await generatePersonalKey();
    await createPersonalKeyWrapping({ clock, wrapper: fakeWrapper("kid-1") })
      .over(store)
      .add("c-1", key);
    await expect(
      createPersonalKeyWrapping({ clock, wrapper: null }).over(store).get("c-1"),
    ).rejects.toThrow(
      new ConfigurationError(
        "A personal key is wrapped under kid-1, and runtime.personalData.keyWrapper is not set",
      ),
    );
    await expect(
      createPersonalKeyWrapping({ clock, wrapper: fakeWrapper("kid-2", ["kid-3"]) })
        .over(store)
        .get("c-1"),
    ).rejects.toThrow(
      new ConfigurationError(
        "A personal key is wrapped under kid-1, which is neither the key wrapper's key nor one of its previous ones",
      ),
    );
    const liar: KeyWrapper = { ...fakeWrapper("kid-1"), unwrap: async () => new Uint8Array(32) };
    await expect(
      createPersonalKeyWrapping({ clock, wrapper: liar }).over(store).get("c-1"),
    ).rejects.toThrow(
      new ConfigurationError(
        "A personal key unwrapped under kid-1 does not match its fingerprint: the key wrapper returned another key",
      ),
    );
  });

  it("passes forgetting, listing and rewrapping through to the store", async () => {
    const store = await keyStore();
    const keys = createPersonalKeyWrapping({ clock, wrapper: fakeWrapper("kid-1") }).over(store);
    const key = await generatePersonalKey();
    await keys.add("c-1", key);
    const [row] = await keys.listWrappedUnder({ kids: ["kid-1"], limit: 10 });
    expect(row?.person).toBe("c-1");
    const hold = { until: "2026-01-01T00:00:30.000Z", attempts: 1 };
    await keys.hold("c-1", row?.key ?? key, hold);
    expect((await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 }))[0]?.hold).toEqual(hold);
    expect(await keys.nextHoldEnd({ kids: ["kid-1"], after: new Date(0) })).toEqual(
      new Date(hold.until),
    );
    expect(await keys.rewrap("c-1", row?.key ?? key, { key: "other", kid: "kid-2" })).toBe(true);
    expect(await store.get("c-1")).toEqual({
      key: "other",
      fingerprint: key.fingerprint,
      kid: "kid-2",
    });
    expect(await keys.remove("c-1")).toBe(true);
    expect(await store.get("c-1")).toBeNull();
  });
});

describe("buildPersonalKeyWrapping", () => {
  it("builds the wrapper from the environment, or none without a definition", async () => {
    const seen: unknown[] = [];
    const wrapper = fakeWrapper("kid-1");
    const built = await buildPersonalKeyWrapping({
      clock,
      definition: {
        kind: "bounda-key-wrapper",
        create: ({ env }) => {
          seen.push(env);
          return wrapper;
        },
      },
      env: { NAME: "value" },
    });
    expect(built.wrapper).toBe(wrapper);
    expect(seen).toEqual([{ NAME: "value" }]);
    expect(
      (await buildPersonalKeyWrapping({ definition: null, env: {}, clock })).wrapper,
    ).toBeNull();
  });
});

describe("isKeyWrapperDefinition", () => {
  it("tells a key wrapper definition from anything else", () => {
    const definition = defineKeyWrapper(() => fakeWrapper("kid-1"));
    expect(definition.kind).toBe("bounda-key-wrapper");
    expect(isKeyWrapperDefinition(definition)).toBe(true);
    for (const value of [
      null,
      undefined,
      "BOUNDA_MASTER_KEY",
      { create: definition.create },
      { kind: "bounda-adapter", create: definition.create },
      { kind: "bounda-key-wrapper", create: "not a function" },
    ]) {
      expect(isKeyWrapperDefinition(value)).toBe(false);
    }
  });
});
