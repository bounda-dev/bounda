import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type PersonalKeyStore,
} from "../../adapter/storage/personal-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { newStoredKey } from "../test-support.ts";
import { fromBase64, type PersonalKey, seal, unseal } from "./crypto.ts";
import { cryptoKeyWrapperOver, defineKeyWrapper, type KeyWrapper } from "./key-wrapper.ts";
import {
  buildPersonalKeyWrapping,
  createPersonalKeyWrapping,
  inSealingOrder,
  UNWRAPPED_KEY_TTL_MS,
  UNWRAPPED_KEYS_KEPT,
} from "./wrapped-keys.ts";

interface FakeWrapper extends KeyWrapper {
  readonly unwrapped: string[];
  // Every array the runtime handed to `wrap` and every one `unwrap` handed back.
  readonly raw: Uint8Array[];
}

// Flips every byte with the kid's length, so each kid wraps differently and wrapping is reversible.
const fakeWrapper = (kid: string, previous: readonly string[] = []): FakeWrapper => {
  const unwrapped: string[] = [];
  const raw: Uint8Array[] = [];
  const flip = (bytes: Uint8Array, under: string) => bytes.map((byte) => byte ^ under.length);
  return {
    kid,
    previous,
    unwrapped,
    raw,
    wrap: async (key) => {
      raw.push(key);
      return flip(key, kid);
    },
    unwrap: async ({ kid: under, wrapped }) => {
      unwrapped.push(under);
      const key = flip(wrapped, under);
      raw.push(key);
      return key;
    },
  };
};

const clock = createFixedClock();

const keyStore = async (): Promise<PersonalKeyStore> =>
  (await memory().createStorage()).personalKeys;

const wrappingOf = (
  wrapper: KeyWrapper | null,
  options: Omit<Parameters<typeof createPersonalKeyWrapping>[0], "wrapper" | "clock"> & {
    readonly clock?: typeof clock;
  } = {},
) =>
  createPersonalKeyWrapping({
    clock,
    ...options,
    wrapper: wrapper === null ? null : cryptoKeyWrapperOver(wrapper),
  });

const fingerprintOf = async (key: Promise<PersonalKey | null>): Promise<string | undefined> =>
  (await key)?.fingerprint;

// Two keys are the same key when what one seals the other opens.
const expectSameKey = async (one: PersonalKey | null, other: PersonalKey | null) => {
  if (one === null || other === null) throw new Error("expected two keys");
  expect(other.fingerprint).toBe(one.fingerprint);
  const sealed = await seal({
    key: one,
    person: "c-1",
    category: DEFAULT_PERSONAL_CATEGORY,
    value: "ana@example.com",
  });
  expect(await unseal({ key: other, sealed })).toBe("ana@example.com");
};

describe("createPersonalKeyWrapping", () => {
  it("stores a new key wrapped under the wrapper's kid, named by its fingerprint, without unwrapping it", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper).over(store);
    const key = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = await store.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(stored).toEqual({ key: expect.any(String), fingerprint: key.fingerprint, kid: "kid-1" });
    expect(wrapper.unwrapped).toEqual([]);
    await expectSameKey(
      key,
      await wrappingOf(wrapper).over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY),
    );
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
    expect(await keys.get("c-1", DEFAULT_PERSONAL_CATEGORY)).toEqual(stored);
  });

  it("answers a create with the key another writer stored first, unwrapped", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const first = await wrappingOf(wrapper).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    await expectSameKey(
      first,
      await wrappingOf(wrapper).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY),
    );
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
  });

  it("opens the key a row read for the person holds", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const key = await wrappingOf(wrapper).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const keys = wrappingOf(wrapper).over(store);
    const stored = await keys.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    if (stored === null) throw new Error("expected a key");
    await expectSameKey(key, await keys.open("c-1", stored));
    expect(await keys.held("c-2", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
  });

  it("keeps one key in force per category, and opens a key by fingerprint, in force or retained", async () => {
    const store = await keyStore();
    const keys = wrappingOf(fakeWrapper("kid-1")).over(store);
    const profile = await keys.create("c-1", "profile");
    const invoices = await keys.create("c-1", "invoices");
    expect(invoices.fingerprint).not.toBe(profile.fingerprint);
    await expectSameKey(profile, await keys.held("c-1", "profile"));
    expect(
      await store.retain("c-1", invoices.fingerprint, {
        since: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2025-12-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(await keys.held("c-1", "invoices")).toBeNull();
    const retained = await keys.opened("c-1", invoices.fingerprint);
    expect(retained?.retained).toBe(true);
    await expectSameKey(invoices, retained);
    expect((await keys.opened("c-1", profile.fingerprint))?.retained).toBe(false);
    expect(await keys.opened("c-2", profile.fingerprint)).toBeNull();
  });

  it("opens every key the person holds, in force or retained, with its category", async () => {
    const store = await keyStore();
    const keys = wrappingOf(null).over(store);
    const profile = await keys.create("c-1", "profile");
    const invoices = await keys.create("c-1", "invoices");
    await keys.create("c-2", "profile");
    await store.retain("c-1", invoices.fingerprint, {
      since: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2025-12-01T00:00:00.000Z",
    });
    const all = await keys.heldAll("c-1");
    expect(all.map(({ category, key }) => [category, key.fingerprint, key.retained])).toEqual(
      expect.arrayContaining([
        ["profile", profile.fingerprint, false],
        ["invoices", invoices.fingerprint, true],
      ]),
    );
    expect(all).toHaveLength(2);
    await expectSameKey(invoices, all.find(({ category }) => category === "invoices")?.key ?? null);
    expect(await keys.heldAll("c-3")).toEqual([]);
  });

  it("holds every key as one that can never be exported: new, read, wrapped or not", async () => {
    for (const wrapper of [fakeWrapper("kid-1"), null]) {
      const store = await keyStore();
      const created = await wrappingOf(wrapper)
        .over(store)
        .create("c-1", DEFAULT_PERSONAL_CATEGORY);
      const read = await wrappingOf(wrapper).over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY);
      for (const key of [created, read]) {
        expect(key?.cryptoKey.extractable).toBe(false);
        expect(key?.cryptoKey.usages.toSorted()).toEqual(["decrypt", "encrypt"]);
        await expect(
          crypto.subtle.exportKey("raw", key?.cryptoKey ?? created.cryptoKey),
        ).rejects.toThrow();
      }
    }
  });

  it("zeroes every raw key it hands to a wrapper of the app's own, or is handed back", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1", ["kid-0"]);
    await wrappingOf(fakeWrapper("kid-0")).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const wrapping = wrappingOf(wrapper);
    await wrapping.over(store).create("c-2", DEFAULT_PERSONAL_CATEGORY);
    await wrapping.over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY);
    await wrapping.wrapped(
      (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey()),
    );
    expect(wrapper.raw.length).toBeGreaterThanOrEqual(4);
    for (const raw of wrapper.raw) expect(raw).toEqual(new Uint8Array(32));
  });

  it("keeps a key once, whatever number of reads, and never answers from it once the row is gone", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper).over(store);
    const key = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    await expectSameKey(key, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    await expectSameKey(key, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    expect(wrapper.unwrapped).toEqual([]);
    // Another instance forgets the person: the cache still holds the key, the row is gone.
    expect(await store.remove("c-1", key.fingerprint)).toBe(true);
    expect(await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
  });

  it("drops the key of a person it forgets", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper).over(store);
    const key = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey());
    expect(await keys.remove("c-1", key.fingerprint)).toBe(true);
    // The same row put back, as a restore would: unwrapped again, so the cache had let it go.
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, stored);
    await expectSameKey(key, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
    expect(await keys.remove("c-2", key.fingerprint)).toBe(false);
    // Read, not created, by this instance: the same.
    expect(await keys.remove("c-1", key.fingerprint)).toBe(true);
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, stored);
    await expectSameKey(key, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    expect(wrapper.unwrapped).toEqual(["kid-1", "kid-1"]);
  });

  it("unwraps once for reads made at the same time", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const key = await wrappingOf(wrapper).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const keys = wrappingOf(wrapper).over(store);
    const [one, other] = await Promise.all([
      keys.held("c-1", DEFAULT_PERSONAL_CATEGORY),
      keys.held("c-1", DEFAULT_PERSONAL_CATEGORY),
    ]);
    await expectSameKey(key, one);
    expect(other?.cryptoKey).toBe(one?.cryptoKey);
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
  });

  it("unwraps again a key whose unwrapping failed", async () => {
    const store = await keyStore();
    const key = await wrappingOf(fakeWrapper("kid-1"))
      .over(store)
      .create("c-1", DEFAULT_PERSONAL_CATEGORY);
    let fail = true;
    const flaky: KeyWrapper = {
      ...fakeWrapper("kid-1"),
      unwrap: async (args) => {
        if (fail) throw new Error("KMS unavailable");
        return fakeWrapper("kid-1").unwrap(args);
      },
    };
    const keys = wrappingOf(flaky).over(store);
    await expect(keys.held("c-1", DEFAULT_PERSONAL_CATEGORY)).rejects.toThrow("KMS unavailable");
    fail = false;
    await expectSameKey(key, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
  });

  it("keeps UNWRAPPED_KEYS_KEPT keys by default", () => {
    expect(UNWRAPPED_KEYS_KEPT).toBe(10_000);
  });

  it("keeps at most as many keys as it is told, the least recently read out first", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper, { keep: 3 }).over(store);
    const persons = Array.from({ length: 4 }, (_, index) => `c-${index}`);
    for (const person of persons) await keys.create(person, DEFAULT_PERSONAL_CATEGORY);
    const reads = () => wrapper.unwrapped.length;
    let before = reads();
    // The first was the oldest, so it went out when the last came in.
    await keys.held("c-0", DEFAULT_PERSONAL_CATEGORY);
    expect(reads()).toBe(before + 1);
    // Reading `c-2` makes it recent, so the next eviction takes `c-3`, not it.
    before = reads();
    await keys.held("c-2", DEFAULT_PERSONAL_CATEGORY);
    expect(reads()).toBe(before);
    await keys.create("c-new", DEFAULT_PERSONAL_CATEGORY);
    before = reads();
    await keys.held("c-2", DEFAULT_PERSONAL_CATEGORY);
    expect(reads()).toBe(before);
    await keys.held("c-3", DEFAULT_PERSONAL_CATEGORY);
    expect(reads()).toBe(before + 1);
  });

  it("keeps a key UNWRAPPED_KEY_TTL_MS by default, five minutes", async () => {
    expect(UNWRAPPED_KEY_TTL_MS).toBe(300_000);
    const store = await keyStore();
    const timed = createFixedClock();
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper, { clock: timed }).over(store);
    await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    timed.advance(UNWRAPPED_KEY_TTL_MS - 1);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(0);
    timed.advance(1);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(1);
  });

  it("drops a key its time after it was kept, however often it is read, with nothing read meanwhile", async () => {
    const store = await keyStore();
    const timed = createFixedClock();
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper, { clock: timed, ttlMs: 1_000 }).over(store);
    const first = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    timed.advance(600);
    await keys.create("c-2", DEFAULT_PERSONAL_CATEGORY);
    expect(timed.pending()).toBe(1);
    timed.advance(399);
    await expectSameKey(first, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    expect(wrapper.unwrapped).toHaveLength(0);
    // Nothing reads: the timer drops the first key when its time is up, then the second.
    timed.advance(1);
    expect(timed.pending()).toBe(1);
    timed.advance(600);
    expect(timed.pending()).toBe(0);
    await expectSameKey(first, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    expect(wrapper.unwrapped).toHaveLength(1);
    expect(await keys.remove("c-1", first.fingerprint)).toBe(true);
    timed.advance(1_000);
    expect(timed.pending()).toBe(0);
  });

  it("unwraps again a key read past its time before the timer dropped it", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const late: typeof clock = { ...createFixedClock(), after: () => () => undefined };
    const keys = wrappingOf(wrapper, { clock: late, ttlMs: 1_000 }).over(store);
    const key = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    late.advance(999);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(0);
    late.advance(1);
    await expectSameKey(key, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    expect(wrapper.unwrapped).toHaveLength(1);
  });

  it("puts a key unwrapped again past its time last, so the next one in is not what goes out", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const late: typeof clock = { ...createFixedClock(), after: () => () => undefined };
    const keys = wrappingOf(wrapper, { clock: late, keep: 2, ttlMs: 1_000 }).over(store);
    await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    late.advance(500);
    await keys.create("c-2", DEFAULT_PERSONAL_CATEGORY);
    late.advance(500);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(1);
    late.advance(100);
    await keys.create("c-3", DEFAULT_PERSONAL_CATEGORY);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(1);
    await keys.held("c-2", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(2);
  });

  it("keeps a key unwrapped again when an older unwrapping of it fails late", async () => {
    const store = await keyStore();
    const key = await wrappingOf(fakeWrapper("kid-1"))
      .over(store)
      .create("c-1", DEFAULT_PERSONAL_CATEGORY);
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
    const keys = wrappingOf(slow, { clock: late, ttlMs: 1_000 }).over(store);
    const first = keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    await new Promise((resolve) => setImmediate(resolve));
    late.advance(1_000);
    await expectSameKey(key, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    fail(new Error("KMS timed out"));
    await expect(first).rejects.toThrow("KMS timed out");
    await expectSameKey(key, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    expect(calls).toBe(2);
  });

  it("unwraps a key anew, exportable, to rewrap it, and keeps none it unwrapped for that", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1", ["kid-0"]);
    const wrapping = wrappingOf(wrapper);
    const keys = wrapping.over(store);
    await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey());
    await wrapping.wrapped(stored);
    await wrapping.wrapped(stored);
    expect(wrapper.unwrapped).toHaveLength(2);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(2);
    wrapping.drop("c-1");
    wrapping.drop("c-9");
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(3);
  });

  it("takes a key kept from further off than its time allows, after the clock was set back, as expired", async () => {
    const store = await keyStore();
    const timed = createFixedClock(new Date("2026-01-01T01:00:00Z"));
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper, { clock: timed, ttlMs: 1_000 }).over(store);
    await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    timed.set(new Date("2026-01-01T00:00:00Z"));
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(1);
  });

  it("still drops a person's new key when they forget them after their old one went out", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper, { keep: 2 }).over(store);
    const old = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    // Forgotten on another instance, then keyed anew here: the old key is still kept.
    await store.remove("c-1", old.fingerprint);
    const renewed = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey());
    // The old key goes out, oldest; the person's new one must stay theirs.
    await keys.create("c-2", DEFAULT_PERSONAL_CATEGORY);
    expect(await keys.remove("c-1", renewed.fingerprint)).toBe(true);
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, stored);
    await expectSameKey(renewed, await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY));
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
  });

  it("drops only the forgotten person's key", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper).over(store);
    const forgotten = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const kept = await keys.create("c-2", DEFAULT_PERSONAL_CATEGORY);
    await keys.remove("c-1", forgotten.fingerprint);
    await expectSameKey(kept, await keys.held("c-2", DEFAULT_PERSONAL_CATEGORY));
    expect(wrapper.unwrapped).toHaveLength(0);
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
    await wrappingOf(fakeWrapper("kid-1"), { clock: watched })
      .over(store)
      .create("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(options).toEqual([{ background: true }]);
  });

  it("drops every key and its timer when closed", async () => {
    const store = await keyStore();
    const timed = createFixedClock();
    const wrapper = fakeWrapper("kid-1");
    const wrapping = wrappingOf(wrapper, { clock: timed });
    await wrapping.over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(timed.pending()).toBe(1);
    wrapping.close();
    expect(timed.pending()).toBe(0);
    await wrapping.over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(1);
  });

  it("opens keys kept unwrapped, from before a wrapper was set, without the wrapper", async () => {
    const store = await keyStore();
    const stored = await newStoredKey();
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, stored);
    const wrapper = fakeWrapper("kid-1");
    expect(
      await fingerprintOf(wrappingOf(wrapper).over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY)),
    ).toBe(stored.fingerprint);
    expect(wrapper.unwrapped).toEqual([]);
  });

  it("unwraps a key under a previous kid, and rewraps it under the current one", async () => {
    const store = await keyStore();
    const key = await wrappingOf(fakeWrapper("old"))
      .over(store)
      .create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey());
    const wrapping = wrappingOf(fakeWrapper("current", ["old"]));
    await expectSameKey(key, await wrapping.over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY));
    const rewrapped = await wrapping.wrapped(stored);
    expect(rewrapped.kid).toBe("current");
    expect(rewrapped.key).not.toBe(stored.key);
    const moved = await keyStore();
    await moved.add("c-1", DEFAULT_PERSONAL_CATEGORY, {
      ...rewrapped,
      fingerprint: key.fingerprint,
    });
    await expectSameKey(key, await wrapping.over(moved).held("c-1", DEFAULT_PERSONAL_CATEGORY));
  });

  it("imports a new key once without a wrapper, never reading it back from the store", async () => {
    const store = await keyStore();
    const imported = vi.spyOn(crypto.subtle, "importKey");
    try {
      const key = await wrappingOf(null).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
      expect(imported).toHaveBeenCalledTimes(1);
      expect(key.fingerprint).toBe(
        (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY))?.fingerprint,
      );
    } finally {
      imported.mockRestore();
    }
  });

  it("keeps keys as they are without a wrapper", async () => {
    const store = await keyStore();
    const wrapping = wrappingOf(null);
    const key = await wrapping.over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = await store.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(stored).toEqual({ key: expect.any(String), fingerprint: key.fingerprint, kid: null });
    expect(fromBase64(stored?.key ?? "")).toHaveLength(32);
    expect(await wrapping.wrapped(stored ?? (await newStoredKey()))).toEqual({
      key: stored?.key,
      kid: null,
    });
    await expectSameKey(
      key,
      await wrappingOf(null).over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY),
    );
  });

  it("refuses a wrapped key without a wrapper, under an unknown kid, or unwrapping to another key", async () => {
    const store = await keyStore();
    await wrappingOf(fakeWrapper("kid-1")).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    await expect(
      wrappingOf(null).over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY),
    ).rejects.toThrow(
      new ConfigurationError(
        "A personal key is wrapped under kid-1, and runtime.personalData.keyWrapper is not set",
      ),
    );
    await expect(
      wrappingOf(fakeWrapper("kid-2", ["kid-3"]))
        .over(store)
        .held("c-1", DEFAULT_PERSONAL_CATEGORY),
    ).rejects.toThrow(
      new ConfigurationError(
        "A personal key is wrapped under kid-1, which is neither the key wrapper's key nor one of its previous ones",
      ),
    );
    const liar: KeyWrapper = { ...fakeWrapper("kid-1"), unwrap: async () => new Uint8Array(32) };
    await expect(
      wrappingOf(liar).over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY),
    ).rejects.toThrow(
      new ConfigurationError(
        "A personal key unwrapped under kid-1 does not match its fingerprint: the key wrapper returned another key, or the database was written before fingerprints were key check values and must be created anew",
      ),
    );
    await expect(
      wrappingOf(liar).wrapped(
        (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey()),
      ),
    ).rejects.toThrow("does not match its fingerprint");
  });

  it("refuses a key kept unwrapped that does not match its fingerprint", async () => {
    const store = await keyStore();
    const [stored, other] = await Promise.all([newStoredKey(), newStoredKey()]);
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, {
      ...stored,
      fingerprint: other.fingerprint,
    });
    await expect(
      wrappingOf(fakeWrapper("kid-1")).over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY),
    ).rejects.toThrow(
      new ConfigurationError(
        "A personal key kept unwrapped does not match its fingerprint: the key was altered in the store, or the database was written before fingerprints were key check values and must be created anew",
      ),
    );
  });

  it("refuses a key rewrapped under a kid it does not know, however recently it kept the key", async () => {
    const store = await keyStore();
    const keys = wrappingOf(fakeWrapper("kid-1")).over(store);
    await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey());
    await store.rewrap("c-1", stored, { key: stored.key, kid: "kid-9" });
    await expect(keys.held("c-1", DEFAULT_PERSONAL_CATEGORY)).rejects.toThrow(
      "A personal key is wrapped under kid-9, which is neither the key wrapper's key nor one of its previous ones",
    );
  });

  it("wraps a key added as it is kept unwrapped, and keeps one already wrapped under its kid as it is", async () => {
    const store = await keyStore();
    const wrapper = fakeWrapper("kid-1");
    const keys = wrappingOf(wrapper).over(store);
    const plain = await newStoredKey();
    expect(await keys.add("c-1", DEFAULT_PERSONAL_CATEGORY, plain)).toMatchObject({
      fingerprint: plain.fingerprint,
      kid: "kid-1",
    });
    expect((await store.get("c-1", DEFAULT_PERSONAL_CATEGORY))?.key).not.toBe(plain.key);
    expect(await fingerprintOf(keys.held("c-1", DEFAULT_PERSONAL_CATEGORY))).toBe(
      plain.fingerprint,
    );
    const wrappedRow = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? plain;
    const unwraps = wrapper.unwrapped.length;
    expect(await keys.add("c-2", DEFAULT_PERSONAL_CATEGORY, wrappedRow)).toEqual(wrappedRow);
    expect(wrapper.unwrapped).toHaveLength(unwraps);
    expect(await wrappingOf(null).over(store).add("c-3", DEFAULT_PERSONAL_CATEGORY, plain)).toEqual(
      plain,
    );
  });

  it("passes reading, adding, forgetting, listing and rewrapping through to the store", async () => {
    const store = await keyStore();
    const keys = wrappingOf(fakeWrapper("kid-1")).over(store);
    const key = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const [row] = await keys.listWrappedUnder({ kids: ["kid-1"], limit: 10 });
    expect(row?.person).toBe("c-1");
    const stored = row?.key ?? (await newStoredKey());
    expect(await keys.get("c-1", DEFAULT_PERSONAL_CATEGORY)).toEqual(stored);
    const other = await wrappingOf(fakeWrapper("kid-1"))
      .over(await keyStore())
      .create("c-2", DEFAULT_PERSONAL_CATEGORY);
    expect((await keys.add("c-2", DEFAULT_PERSONAL_CATEGORY, stored)).fingerprint).toBe(
      key.fingerprint,
    );
    expect(other.fingerprint).not.toBe(key.fingerprint);
    const hold = { until: "2026-01-01T00:00:30.000Z", attempts: 1 };
    await keys.hold("c-1", stored, hold);
    expect((await store.listWrappedUnder({ kids: ["kid-1"], limit: 10 }))[0]?.hold).toEqual(hold);
    expect(await keys.nextHoldEnd({ kids: ["kid-1"], after: new Date(0) })).toEqual(
      new Date(hold.until),
    );
    expect(await keys.rewrap("c-1", stored, { key: "other", kid: "kid-2" })).toBe(true);
    expect(await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)).toEqual({
      key: "other",
      fingerprint: key.fingerprint,
      kid: "kid-2",
    });
    expect(await keys.remove("c-1", key.fingerprint)).toBe(true);
    expect(await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
  });
});

describe("buildPersonalKeyWrapping", () => {
  it("builds the wrapper from the environment, or none without a definition", async () => {
    const seen: unknown[] = [];
    const built = await buildPersonalKeyWrapping({
      clock,
      definition: defineKeyWrapper(({ env }) => {
        seen.push(env);
        return fakeWrapper("kid-1", ["kid-0"]);
      }),
      env: { NAME: "value" },
    });
    expect(built.wrapper).toMatchObject({ kid: "kid-1", previous: ["kid-0"] });
    expect(seen).toEqual([{ NAME: "value" }]);
    expect(
      (await buildPersonalKeyWrapping({ definition: null, env: {}, clock })).wrapper,
    ).toBeNull();
  });
});

describe("inSealingOrder", () => {
  it("orders keys by category, then by fingerprint, whatever order they came in", () => {
    const key = (category: string, fingerprint: string) => ({
      category,
      key: { fingerprint, cryptoKey: {} as CryptoKey, retained: false },
    });
    const ordered = inSealingOrder([
      key("profile", "b"),
      key("default", "z"),
      key("profile", "a"),
      key("invoices", "m"),
    ]);
    expect(
      ordered.map(({ category, key: { fingerprint } }) => `${category}:${fingerprint}`),
    ).toEqual(["default:z", "invoices:m", "profile:a", "profile:b"]);
  });
});
