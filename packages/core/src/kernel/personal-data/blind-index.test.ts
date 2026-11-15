import { describe, expect, it, vi } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { createMemoryIndexKeyStore } from "../../memory/index-key-store.ts";
import { createMemoryTenancyStore } from "../../memory/tenancy-store.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { openTestTenantKeys, testMaster } from "../test-support.ts";
import { indexedText, openDatabaseKey } from "./blind-index.ts";
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
});
