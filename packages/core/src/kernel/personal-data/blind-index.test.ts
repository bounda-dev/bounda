import { describe, expect, it, vi } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { createMemoryIndexKeyStore } from "../../memory/index-key-store.ts";
import { createMemoryTenancyStore } from "../../memory/tenancy-store.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { openTestTenantKeys, testMaster } from "../test-support.ts";
import { epochMark, epochNumber, indexedText, openDatabaseKey } from "./blind-index.ts";
import { fingerprintOf, generateWrappableKey, toBase64, withRawKey } from "./crypto.ts";
import type { TenantKeys } from "./tenant-keys.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

const wrappingUnder = (tenantKeys: TenantKeys) =>
  createPersonalKeyWrapping({ tenantKeys, master: testMaster, clock: createFixedClock() });
describe("indexedText", () => {
  it("indexes a value by its JSON, a date by its ISO string, and a JSON field whatever the order of its keys", () => {
    expect(indexedText("string", "a@x")).toBe('"a@x"');
    expect(indexedText("number", 4)).toBe("4");
    expect(indexedText("boolean", true)).toBe("true");
    expect(indexedText("date", new Date("2026-01-01T00:00:00.000Z"))).toBe(
      '"2026-01-01T00:00:00.000Z"',
    );
    expect(indexedText("date", "2026-01-01T00:00:00Z")).toBe('"2026-01-01T00:00:00.000Z"');
    expect(indexedText("json", { b: [{ d: 1, c: 2 }], a: null })).toBe(
      indexedText("json", { a: null, b: [{ c: 2, d: 1 }] }),
    );
    expect(indexedText("json", { b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("openDatabaseKey", () => {
  it("creates the database's key once, wrapped under the tenant's, and indexes alike across instances, apart for each read model and field", async () => {
    const store = createMemoryIndexKeyStore();
    const clock = createFixedClock();
    const tenantKeys = await openTestTenantKeys();
    const one = await openDatabaseKey({ store, wrapping: wrappingUnder(tenantKeys), clock });
    const [stored] = store.rows();
    expect(stored).toMatchObject({ scope: "app", kid: (await tenantKeys.kids()).kid });
    const other = await openDatabaseKey({ store, wrapping: wrappingUnder(tenantKeys), clock });
    const args = { readModel: "customers", field: "email", type: "string" as const, value: "a@x" };
    const index = await one.indexer.index(args);
    expect(index).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(await other.indexer.index(args)).toBe(index);
    expect(store.rows()).toHaveLength(1);
    expect(await one.indexer.index({ ...args, value: "b@x" })).not.toBe(index);
    expect(await one.indexer.index({ ...args, field: "backup" })).not.toBe(index);
    expect(await one.indexer.index({ ...args, readModel: "accounts" })).not.toBe(index);
    const elsewhere = await openDatabaseKey({
      store: createMemoryIndexKeyStore(),
      wrapping: wrappingUnder(tenantKeys),
      clock,
    });
    expect(await elsewhere.indexer.index(args)).not.toBe(index);
    const sealed = await one.atRest.seal("state");
    expect(await other.atRest.open(sealed)).toBe("state");
    await expect(elsewhere.atRest.open(sealed)).rejects.toThrow();
  });

  it("rewraps a key wrapped under an older version of the tenant's key under the one in force", async () => {
    const store = createMemoryIndexKeyStore();
    const clock = createFixedClock();
    const tenantStore = createMemoryTenantKeyStore();
    const tenancy = createMemoryTenancyStore();
    const tenantKeys = await openTestTenantKeys({ store: tenantStore, tenancy });
    const before = await openDatabaseKey({ store, wrapping: wrappingUnder(tenantKeys), clock });
    const args = { readModel: "customers", field: "email", type: "string" as const, value: "a@x" };
    const index = await before.indexer.index(args);
    const rotated = await tenantKeys.rotate();
    const after = await openDatabaseKey({ store, wrapping: wrappingUnder(tenantKeys), clock });
    expect(store.rows()[0]?.kid).toBe(rotated);
    expect(await after.indexer.index(args)).toBe(index);
  });

  it("replaces a key a version of Bounda before tenant keys created, so its indexes are computed anew", async () => {
    const store = createMemoryIndexKeyStore();
    const clock = createFixedClock();
    const legacy = await generateWrappableKey();
    const before = {
      key: await withRawKey(legacy, async (raw) => toBase64(raw)),
      fingerprint: await fingerprintOf(legacy),
      kid: null,
    };
    await store.add(before, clock.now());
    const tenantKeys = await openTestTenantKeys();
    const opened = await openDatabaseKey({ store, wrapping: wrappingUnder(tenantKeys), clock });
    const [row] = store.rows();
    expect(row?.kid).toBe((await tenantKeys.kids()).kid);
    expect(row?.fingerprint).not.toBe(before.fingerprint);
    expect(opened.indexer.epoch).toBe(row?.fingerprint);
    const again = await openDatabaseKey({ store, wrapping: wrappingUnder(tenantKeys), clock });
    expect(again.indexer.epoch).toBe(opened.indexer.epoch);
  });

  it("derives the keys of the indexes and of what is sealed at rest with no byte in JavaScript", async () => {
    const store = createMemoryIndexKeyStore();
    const clock = createFixedClock();
    const tenantKeys = await openTestTenantKeys();
    await openDatabaseKey({ store, wrapping: wrappingUnder(tenantKeys), clock });
    const exported = vi.spyOn(crypto.subtle, "exportKey");
    const imported = vi.spyOn(crypto.subtle, "importKey");
    const encrypted = vi.spyOn(crypto.subtle, "encrypt");
    const derived = vi.spyOn(crypto.subtle, "deriveKey");
    try {
      const opened = await openDatabaseKey({ store, wrapping: wrappingUnder(tenantKeys), clock });
      // The index key is derived as one that can never be exported.
      expect(derived.mock.calls.map((call) => call[3])).toEqual([false]);
      await opened.indexer.index({
        readModel: "customers",
        field: "email",
        type: "string",
        value: "a@x",
      });
      const sealed = await opened.atRest.seal("state");
      expect(await opened.atRest.open(sealed)).toBe("state");
      expect(exported).not.toHaveBeenCalled();
      expect(imported).not.toHaveBeenCalled();
      // Only to seal the state and to check the key against its fingerprint.
      expect(encrypted.mock.calls.every(([, , data]) => (data as Uint8Array).length <= 5)).toBe(
        true,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("takes the key a reseal puts in force within its time, keeping the previous one to open and find with until it goes", async () => {
    const store = createMemoryIndexKeyStore();
    const clock = createFixedClock();
    const tenantKeys = await openTestTenantKeys();
    const wrapping = wrappingUnder(tenantKeys);
    const opened = await openDatabaseKey({ store, wrapping, clock, ttlMs: 1_000 });
    const args = { readModel: "customers", field: "email", type: "string" as const, value: "a@x" };
    const before = await opened.indexer.index(args);
    const sealedBefore = await opened.atRest.seal("state");
    const [lookup] = await opened.atRest.lookups("k-1");
    expect(await opened.atRest.lookups("k-1")).toEqual([lookup]);
    expect(await opened.indexer.indexAll(args)).toEqual([before]);
    const from = (await store.get()) as NonNullable<Awaited<ReturnType<typeof store.get>>>;
    const to = (await wrapping.generate()).stored;
    await store.supersede(from, to, await wrapping.wrapped(from), clock.now());
    // Within its time, what it read stands.
    clock.advance(999);
    expect(await opened.indexer.index(args)).toBe(before);
    expect(opened.indexer.epoch).toBe(from.fingerprint);
    clock.advance(1);
    const after = await opened.indexer.index(args);
    expect(after).not.toBe(before);
    expect(opened.indexer.epoch).toBe(to.fingerprint);
    expect(await opened.indexer.indexAll(args)).toEqual([after, before]);
    expect(await opened.atRest.lookups("k-1")).toEqual([await opened.atRest.lookup("k-1"), lookup]);
    expect(await opened.atRest.open(sealedBefore)).toBe("state");
    const sealedAfter = await opened.atRest.seal("next");
    expect(await opened.atRest.open(sealedAfter)).toBe("next");
    const pinned = await opened.indexer.pinned();
    expect(pinned.epoch).toBe(to.fingerprint);
    expect(pinned.number).toBe(await epochNumber(to.fingerprint));
    expect(await pinned.indexAll(args)).toEqual([after]);
    expect((await pinned.forTable({} as never)).epoch).toBe(to.fingerprint);
    expect((await pinned.pinned()).number).toBe(pinned.number);
    // A table keeps the key it is indexed under, as its mark says, or the previous one unmarked.
    const marks = new Map<string, number>();
    const table = (empty: boolean, writes = true) => ({
      readModel: "customers",
      checkpoints: {
        get: async (name: string) => marks.get(name) ?? 0,
        set: async (name: string, value: number) => {
          marks.set(name, value);
        },
      },
      isEmpty: async () => empty,
      writes,
    });
    expect((await opened.indexer.forTable(table(false, false))).epoch).toBe(from.fingerprint);
    expect(marks.size).toBe(0);
    expect((await opened.indexer.forTable(table(true))).epoch).toBe(to.fingerprint);
    expect(marks.get(epochMark("customers"))).toBe(await epochNumber(to.fingerprint));
    marks.set(epochMark("customers"), await epochNumber(from.fingerprint));
    expect(await (await opened.indexer.forTable(table(true))).index(args)).toBe(before);
    marks.set(epochMark("customers"), await epochNumber(to.fingerprint));
    expect(await (await opened.indexer.forTable(table(false))).index(args)).toBe(after);
    // Once dropped, the previous key opens nothing more, and every table is under the new one.
    await store.dropPrevious(
      (await store.previous()) as NonNullable<Awaited<ReturnType<typeof store.previous>>>,
    );
    await opened.refresh();
    marks.set(epochMark("customers"), await epochNumber(from.fingerprint));
    expect((await opened.indexer.forTable(table(false))).epoch).toBe(to.fingerprint);
    expect(await opened.indexer.indexAll(args)).toEqual([after]);
    await expect(opened.atRest.open(sealedBefore)).rejects.toThrow();
    expect(await opened.atRest.lookups("k-1")).toHaveLength(1);
    // A clock set back reads the store again.
    clock.set(new Date(clock.now().getTime() - 10));
    const get = vi.spyOn(store, "get");
    await opened.indexer.index(args);
    expect(get).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("names a database key's epoch by a positive number, and a read model's mark after it", async () => {
    expect(epochMark("customers")).toBe("read-model:epoch:customers");
    const numbers = await Promise.all(["a", "b", "c", "d"].map(epochNumber));
    for (const number of numbers) {
      expect(Number.isInteger(number) && number > 0 && number <= 0x7fffffff).toBe(true);
    }
    expect(new Set(numbers).size).toBe(4);
    expect(await epochNumber("a")).toBe(numbers[0]);
  });
});
