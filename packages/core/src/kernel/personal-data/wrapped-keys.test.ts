import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type PersonalKeyStore,
} from "../../adapter/storage/personal-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError, TenantForgottenError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { newStoredKey, testTenantKeys } from "../test-support.ts";
import {
  fingerprintOf as fingerprintOfKey,
  generateWrappableKey,
  type PersonalKey,
  seal,
  TENANT_KEY_ALGORITHM,
  TENANT_KEY_USAGES,
  toBase64,
  unseal,
  withRawKey,
} from "./crypto.ts";
import { buildKeyWrapper } from "./key-wrapper.ts";
import { ephemeralMasterKey } from "./master-key.ts";
import type { TenantKeys } from "./tenant-keys.ts";
import {
  createPersonalKeyWrapping,
  inSealingOrder,
  keylessWrapping,
  UNWRAPPED_KEY_TTL_MS,
  UNWRAPPED_KEYS_KEPT,
} from "./wrapped-keys.ts";

interface FakeTenant extends TenantKeys {
  // Every version a person's key was unwrapped under, once per unwrapping.
  readonly unwrapped: string[];
}

// One version per kid, for the whole file: two fakes that name a kid share its key.
const versions = new Map<string, Promise<CryptoKey>>();
const versionOf = (kid: string): Promise<CryptoKey> => {
  const known = versions.get(kid);
  if (known !== undefined) return known;
  const created = crypto.subtle.generateKey({ name: TENANT_KEY_ALGORITHM, length: 256 }, false, [
    ...TENANT_KEY_USAGES,
  ]);
  versions.set(kid, created);
  return created;
};

const fakeTenant = (
  kid: string,
  previous: readonly string[] = [],
  before: () => Promise<void> = async () => undefined,
): FakeTenant => {
  const unwrapped: string[] = [];
  const known = [kid, ...previous];
  return {
    ...testTenantKeys,
    unwrapped,
    current: async () => ({ kid, key: await versionOf(kid) }),
    keyOf: async (asked) => {
      if (!known.includes(asked)) return null;
      unwrapped.push(asked);
      await before();
      return versionOf(asked);
    },
    knows: (asked) => known.includes(asked),
    kids: async () => ({ kid, previous, since: new Date(0).toISOString() }),
  };
};

const master = buildKeyWrapper({ definition: ephemeralMasterKey(), env: {} });

const clock = createFixedClock();

const keyStore = async (): Promise<PersonalKeyStore> =>
  (await memory().createStorage()).personalKeys;

const wrappingOf = (
  tenant: TenantKeys,
  options: Omit<
    Parameters<typeof createPersonalKeyWrapping>[0],
    "tenantKeys" | "master" | "clock"
  > & {
    readonly clock?: typeof clock;
  } = {},
) =>
  createPersonalKeyWrapping({
    clock,
    ...options,
    tenantKeys: tenant,
    master: {
      kid: "master-1",
      previous: [],
      unwrap: async (args) => (await master).unwrap({ ...args, kid: (await master).kid }),
    },
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

// A key as a version of Bounda before key wrappers kept it: its raw bytes in base64.
const rawRow = async () => {
  const key = await generateWrappableKey();
  return {
    key: await withRawKey(key, async (raw) => toBase64(raw)),
    fingerprint: await fingerprintOfKey(key),
    kid: null,
  };
};

describe("createPersonalKeyWrapping", () => {
  it("hands every call it does not wrap straight to the store, with what it answered", async () => {
    const calls: unknown[][] = [];
    const store = new Proxy({} as PersonalKeyStore, {
      get:
        (_, name) =>
        (...args: unknown[]) => {
          calls.push([name, ...args]);
          return Promise.resolve(`${String(name)} answer`);
        },
    });
    const keys = wrappingOf(fakeTenant("kid-1")).over(store);
    const passed: [keyof PersonalKeyStore, unknown[]][] = [
      ["retain", ["c-1", "f-1", { since: "s", lastActiveAt: "a" }]],
      ["touch", ["c-1", "a"]],
      ["listDue", [{ category: "x", limit: 1 }]],
      ["holdDue", ["c-1", "f-1", "a", { until: "u", attempts: 1 }]],
      ["nextDueHoldEnd", [{ category: "x", after: new Date(0) }]],
      ["listRetained", [{ except: [], limit: 1 }]],
      ["nextRetainedHoldEnd", [{ except: [], after: new Date(0) }]],
      ["countDue", [{ category: "x" }]],
      ["countRetained", [{ except: ["y"] }]],
      ["releaseDueHolds", []],
      ["listWrappedUnder", [{ kids: [null], limit: 1 }]],
      ["hold", ["c-1", { key: "k", fingerprint: "f-1", kid: null }, { until: "u", attempts: 1 }]],
      ["nextHoldEnd", [{ kids: [null], after: new Date(0) }]],
      ["countWrappedUnder", [{ kids: [null] }]],
      ["releaseHolds", []],
      ["listMany", [["c-1", "c-2"]]],
      ["kids", []],
      ["categories", []],
    ];
    for (const [name, args] of passed) {
      const call = keys[name] as (...args: unknown[]) => Promise<unknown>;
      expect(await call(...args)).toBe(`${name} answer`);
      expect(calls.at(-1)).toEqual([name, ...args]);
    }
  });

  it("stores a new key wrapped under the tenant key in force, named by its fingerprint, without unwrapping it", async () => {
    const store = await keyStore();
    const wrapper = fakeTenant("kid-1");
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
    const wrapper = fakeTenant("kid-1");
    const first = await wrappingOf(wrapper).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    await expectSameKey(
      first,
      await wrappingOf(wrapper).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY),
    );
    expect(wrapper.unwrapped).toEqual(["kid-1"]);
  });

  it("opens the key a row read for the person holds", async () => {
    const store = await keyStore();
    const wrapper = fakeTenant("kid-1");
    const key = await wrappingOf(wrapper).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const keys = wrappingOf(wrapper).over(store);
    const stored = await keys.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    if (stored === null) throw new Error("expected a key");
    await expectSameKey(key, await keys.open("c-1", stored));
    expect(await keys.held("c-2", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
  });

  it("keeps one key in force per category, and opens a key by fingerprint, in force or retained", async () => {
    const store = await keyStore();
    const keys = wrappingOf(fakeTenant("kid-1")).over(store);
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
    const keys = wrappingOf(fakeTenant("kid-1")).over(store);
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

  it("holds every key as one that can never be exported: new or read", async () => {
    for (const wrapper of [fakeTenant("kid-1")]) {
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

  it("keeps a key once, whatever number of reads, and never answers from it once the row is gone", async () => {
    const store = await keyStore();
    const wrapper = fakeTenant("kid-1");
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
    const wrapper = fakeTenant("kid-1");
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
    const wrapper = fakeTenant("kid-1");
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
    const key = await wrappingOf(fakeTenant("kid-1"))
      .over(store)
      .create("c-1", DEFAULT_PERSONAL_CATEGORY);
    let fail = true;
    const flaky = fakeTenant("kid-1", [], async () => {
      if (fail) throw new Error("KMS unavailable");
    });
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
    const wrapper = fakeTenant("kid-1");
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
    const wrapper = fakeTenant("kid-1");
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
    const wrapper = fakeTenant("kid-1");
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
    const wrapper = fakeTenant("kid-1");
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
    const wrapper = fakeTenant("kid-1");
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
    const key = await wrappingOf(fakeTenant("kid-1"))
      .over(store)
      .create("c-1", DEFAULT_PERSONAL_CATEGORY);
    let fail: (error: Error) => void = () => undefined;
    let calls = 0;
    const slow = fakeTenant("kid-1", [], async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((_, reject) => {
          fail = reject;
        });
      }
    });
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
    const wrapper = fakeTenant("kid-1", ["kid-0"]);
    const wrapping = wrappingOf(wrapper);
    const keys = wrapping.over(store);
    await wrappingOf(fakeTenant("kid-0")).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey());
    await wrapping.wrapped(stored);
    await wrapping.wrapped(stored);
    expect(wrapper.unwrapped).toEqual(["kid-0", "kid-0"]);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(3);
    // One under the version in force is kept as it is, unwrapped for nothing.
    const current = await keys.create("c-2", DEFAULT_PERSONAL_CATEGORY);
    const row = (await store.get("c-2", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey());
    expect(await wrapping.wrapped(row)).toEqual({ key: row.key, kid: "kid-1" });
    expect(row.fingerprint).toBe(current.fingerprint);
    expect(wrapper.unwrapped).toHaveLength(3);
    wrapping.drop("c-1");
    wrapping.drop("c-9");
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(4);
  });

  it("takes a key kept from further off than its time allows, after the clock was set back, as expired", async () => {
    const store = await keyStore();
    const timed = createFixedClock(new Date("2026-01-01T01:00:00Z"));
    const wrapper = fakeTenant("kid-1");
    const keys = wrappingOf(wrapper, { clock: timed, ttlMs: 1_000 }).over(store);
    await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    timed.set(new Date("2026-01-01T00:00:00Z"));
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(1);
  });

  it("still drops a person's new key when they forget them after their old one went out", async () => {
    const store = await keyStore();
    const wrapper = fakeTenant("kid-1");
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
    const wrapper = fakeTenant("kid-1");
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
    await wrappingOf(fakeTenant("kid-1"), { clock: watched })
      .over(store)
      .create("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(options).toEqual([{ background: true }]);
  });

  it("drops every key and its timer when closed", async () => {
    const store = await keyStore();
    const timed = createFixedClock();
    const wrapper = fakeTenant("kid-1");
    const wrapping = wrappingOf(wrapper, { clock: timed });
    await wrapping.over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(timed.pending()).toBe(1);
    wrapping.close();
    expect(timed.pending()).toBe(0);
    await wrapping.over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(1);
  });

  it("opens keys kept unwrapped, from before a wrapper was required, without the tenant's key", async () => {
    const store = await keyStore();
    const stored = await rawRow();
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, stored);
    const wrapper = fakeTenant("kid-1");
    expect(
      await fingerprintOf(wrappingOf(wrapper).over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY)),
    ).toBe(stored.fingerprint);
    expect(wrapper.unwrapped).toEqual([]);
  });

  it("unwraps a key under a previous kid, and rewraps it under the current one", async () => {
    const store = await keyStore();
    const key = await wrappingOf(fakeTenant("old"))
      .over(store)
      .create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey());
    const wrapping = wrappingOf(fakeTenant("current", ["old"]));
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

  it("opens a key wrapped under the master key before tenant keys, and rewraps it under the tenant's", async () => {
    const store = await keyStore();
    const person = await generateWrappableKey();
    const legacy = await master;
    const { wrapped } = await legacy.wrap(person);
    const fingerprint = await fingerprintOfKey(person);
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, {
      key: toBase64(wrapped),
      fingerprint,
      kid: "master-1",
    });
    const tenant = fakeTenant("kid-1");
    const wrapping = wrappingOf(tenant);
    const asked: unknown[] = [];
    const recording = createPersonalKeyWrapping({
      clock,
      tenantKeys: tenant,
      master: {
        kid: "master-1",
        previous: [],
        unwrap: async (args) => {
          asked.push(args.kind);
          return (await master).unwrap({ ...args, kid: (await master).kid });
        },
      },
    });
    await recording.over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY);
    // A person's key, as the master key wrapped it before tenant keys.
    expect(asked).toEqual(["personal"]);
    expect(await fingerprintOf(wrapping.over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY))).toBe(
      fingerprint,
    );
    expect(tenant.unwrapped).toEqual([]);
    const stored = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await rawRow());
    const rewrapped = await wrapping.wrapped(stored);
    expect(rewrapped.kid).toBe("kid-1");
    expect(await wrapping.kids()).toEqual({ kid: "kid-1", previous: ["master-1", null] });
  });

  it("refuses a key under an unknown kid, or under a version that is not the one it was wrapped under", async () => {
    const store = await keyStore();
    await wrappingOf(fakeTenant("kid-1")).over(store).create("c-1", DEFAULT_PERSONAL_CATEGORY);
    await expect(
      wrappingOf(fakeTenant("kid-2", ["kid-3"]))
        .over(store)
        .held("c-1", DEFAULT_PERSONAL_CATEGORY),
    ).rejects.toThrow(
      new ConfigurationError(
        "A key is wrapped under kid-1, which is neither a version of the tenant's key nor a master key the key wrapper knows",
      ),
    );
    const liar: TenantKeys = { ...fakeTenant("kid-1"), keyOf: () => versionOf("kid-other") };
    const altered = await wrappingOf(liar)
      .over(store)
      .held("c-1", DEFAULT_PERSONAL_CATEGORY)
      .catch((error: unknown) => error);
    expect(altered).toBeInstanceOf(ConfigurationError);
    expect((altered as Error).message).toBe(
      "A key does not unwrap under the tenant's key kid-1: the key was altered in the store",
    );
    // What WebCrypto said is kept, for whoever reads the error.
    expect((altered as Error).cause).toBeInstanceOf(Error);
    await expect(
      wrappingOf({
        ...liar,
        current: async () => ({ kid: "kid-2", key: await versionOf("kid-2") }),
      }).wrapped((await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey())),
    ).rejects.toThrow("does not unwrap under the tenant's key");
  });

  it("refuses every key, kept or not, once the tenant is forgotten", async () => {
    const store = await keyStore();
    let forgotten = false;
    const tenant = fakeTenant("kid-1");
    const forgetting: TenantKeys = {
      ...tenant,
      knows: (kid) => {
        if (forgotten) throw new TenantForgottenError("acme", "2026-01-01T00:00:00.000Z");
        return tenant.knows(kid);
      },
    };
    const keys = wrappingOf(forgetting).over(store);
    await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    forgotten = true;
    await expect(keys.held("c-1", DEFAULT_PERSONAL_CATEGORY)).rejects.toThrow(TenantForgottenError);
  });

  it("refuses a key kept unwrapped that does not match its fingerprint", async () => {
    const store = await keyStore();
    const [stored, other] = await Promise.all([rawRow(), rawRow()]);
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, {
      ...stored,
      fingerprint: other.fingerprint,
    });
    await expect(
      wrappingOf(fakeTenant("kid-1")).over(store).held("c-1", DEFAULT_PERSONAL_CATEGORY),
    ).rejects.toThrow(
      new ConfigurationError(
        "A personal key kept unwrapped does not match its fingerprint: the key was altered in the store, or the database was written before fingerprints were key check values and must be created anew",
      ),
    );
  });

  it("refuses a key rewrapped under a kid it does not know, however recently it kept the key", async () => {
    const store = await keyStore();
    const keys = wrappingOf(fakeTenant("kid-1")).over(store);
    await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)) ?? (await newStoredKey());
    await store.rewrap("c-1", stored, { key: stored.key, kid: "kid-9" });
    await expect(keys.held("c-1", DEFAULT_PERSONAL_CATEGORY)).rejects.toThrow(
      "A key is wrapped under kid-9, which is neither a version of the tenant's key nor a master key the key wrapper knows",
    );
  });

  it("wraps a key added as it is kept unwrapped, and keeps one already wrapped under its kid as it is", async () => {
    const store = await keyStore();
    const wrapper = fakeTenant("kid-1");
    const keys = wrappingOf(wrapper).over(store);
    const plain = await rawRow();
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
  });

  it("passes reading, adding, forgetting, listing and rewrapping through to the store", async () => {
    const store = await keyStore();
    const keys = wrappingOf(fakeTenant("kid-1")).over(store);
    const key = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const [row] = await keys.listWrappedUnder({ kids: ["kid-1"], limit: 10 });
    expect(row?.person).toBe("c-1");
    const stored = row?.key ?? (await newStoredKey());
    expect(await keys.get("c-1", DEFAULT_PERSONAL_CATEGORY)).toEqual(stored);
    const other = await wrappingOf(fakeTenant("kid-1"))
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

describe("isTenantWrapped and derivationBase", () => {
  it("tells a key under a version of the tenant's key from one under a master key, none, or a stranger", async () => {
    const wrapping = wrappingOf(fakeTenant("kid-1", ["kid-0"]));
    const row = (kid: string | null) => ({ key: "k", fingerprint: "f", kid });
    expect(wrapping.isTenantWrapped(row("kid-1"))).toBe(true);
    expect(wrapping.isTenantWrapped(row("kid-0"))).toBe(true);
    expect(wrapping.isTenantWrapped(row("master-1"))).toBe(false);
    expect(wrapping.isTenantWrapped(row(null))).toBe(false);
    expect(wrapping.isTenantWrapped(row("kid-9"))).toBe(false);
  });

  it("derives from a key under the tenant's key alone, never from one kept unwrapped", async () => {
    await expect(wrappingOf(fakeTenant("kid-1")).derivationBase(await rawRow())).rejects.toThrow(
      new ConfigurationError(
        "A key is wrapped under , which is neither a version of the tenant's key nor a master key the key wrapper knows",
      ),
    );
  });

  it("clears every key of the store, and those it kept", async () => {
    const store = await keyStore();
    const keys = wrappingOf(fakeTenant("kid-1")).over(store);
    await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(await keys.clear()).toBe(1);
    expect(await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
  });
});

describe("keylessWrapping", () => {
  it("refuses every call that needs a key, saying what to set, and wraps nothing", async () => {
    const wrapping = keylessWrapping();
    const refusal = new ConfigurationError(
      "A personal key is needed, and the app has no keys: set runtime.personalData.keyWrapper and runtime.personalData.tenantKeys",
    );
    const stored = await rawRow();
    for (const call of [
      () => wrapping.kids(),
      () => wrapping.wrapped(stored),
      () => wrapping.unwrap(stored),
      () => wrapping.derivationBase(stored),
      () => wrapping.generate(),
    ]) {
      await expect(call()).rejects.toThrow(refusal);
    }
    expect(wrapping.isTenantWrapped(stored)).toBe(false);
    expect(wrapping.drop("c-1")).toBeUndefined();
    expect(wrapping.close()).toBeUndefined();
    const store = await keyStore();
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, stored);
    const keys = wrapping.over(store);
    await expect(keys.opened("c-1", stored.fingerprint)).rejects.toThrow(refusal);
    await expect(keys.heldAll("c-1")).rejects.toThrow(refusal);
    await expect(keys.heldAllOf(["c-1"])).rejects.toThrow(refusal);
    await expect(keys.open("c-1", stored)).rejects.toThrow(refusal);
  });

  it("passes the store through, and refuses anything that would need a key", async () => {
    const store = await keyStore();
    const keys = keylessWrapping().over(store);
    expect(await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
    expect(await keys.heldAll("c-1")).toEqual([]);
    expect(await keys.heldAllOf(["c-1"])).toEqual(new Map());
    expect(await keys.opened("c-1", "f-1")).toBeNull();
    await expect(keys.create("c-1", DEFAULT_PERSONAL_CATEGORY)).rejects.toThrow(ConfigurationError);
    await store.add("c-1", DEFAULT_PERSONAL_CATEGORY, await rawRow());
    await expect(keys.held("c-1", DEFAULT_PERSONAL_CATEGORY)).rejects.toThrow(ConfigurationError);
    await expect(keylessWrapping().generate()).rejects.toThrow(ConfigurationError);
  });
});

describe("inSealingOrder", () => {
  it("orders keys by category, then by fingerprint, whatever order they came in", () => {
    const key = (category: string, fingerprint: string) => ({
      category,
      key: { fingerprint, cryptoKey: {} as CryptoKey, retained: false },
      retainedSince: null,
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

describe("the keys a reseal superseded", () => {
  it("counts them through the store, and lets go of every key kept once they are destroyed", async () => {
    const store = await keyStore();
    const wrapper = fakeTenant("kid-1");
    const wrapping = wrappingOf(wrapper);
    const keys = wrapping.over(store);
    const old = await keys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
    const stored = await store.get("c-1", DEFAULT_PERSONAL_CATEGORY);
    const fresh = await wrapping.generate();
    if (stored === null) throw new Error("no key stored");
    await store.supersede("c-1", stored, { ...fresh.stored, at: "2026-03-01T00:00:00.000Z" });
    expect(await keys.countSuperseded()).toBe(1);
    const opened = await keys.opened("c-1", old.fingerprint);
    expect(opened?.successor).toBe(fresh.key.fingerprint);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    const unwrapped = wrapper.unwrapped.length;
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped).toHaveLength(unwrapped);
    expect(await keys.destroySuperseded()).toBe(1);
    expect(await keys.countSuperseded()).toBe(0);
    await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(wrapper.unwrapped.length).toBeGreaterThan(unwrapped);
  });

  it("gives a key no one keeps for a value that must read as forgotten, with keys or without", async () => {
    const store = await keyStore();
    const keyless = keylessWrapping().over(store);
    const one = await keyless.discarded("c-1");
    const two = await wrappingOf(fakeTenant("kid-1")).over(store).discarded("c-1");
    expect(one.fingerprint).not.toBe(two.fingerprint);
    expect(one.cryptoKey.extractable).toBe(false);
    expect(await store.list("c-1")).toEqual([]);
  });
});
