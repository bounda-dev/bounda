import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { createMemoryTenancyStore } from "../../memory/tenancy-store.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { toBase64 } from "./crypto.ts";
import { buildKeyWrapper, type CryptoKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import {
  listTenantsUnderPreviousMaster,
  rewrapRecordUnderMaster,
  rewrapTenantKeys,
  tenantsUnderPreviousMaster,
} from "./master-rotation.ts";
import { defineTenantKeyStore } from "./tenant-key-source.ts";
import { openTenantKeys } from "./tenant-keys.ts";

const env = {
  FIRST: toBase64(crypto.getRandomValues(new Uint8Array(32))),
  SECOND: toBase64(crypto.getRandomValues(new Uint8Array(32))),
};

const masterOf = (from: string, previous: readonly string[] = []): Promise<CryptoKeyWrapper> =>
  buildKeyWrapper({ definition: masterKey({ from, previous }), env });

// Each tenant's first version, under `master`, in `store`.
const tenantsIn = async (
  store: TenantKeyStore,
  master: CryptoKeyWrapper,
  tenants: readonly string[],
): Promise<void> => {
  for (const tenant of tenants) {
    await openTenantKeys({
      tenant,
      store,
      tenancy: createMemoryTenancyStore(),
      master,
      clock: createFixedClock(),
      holdsTenantWrapped: async () => false,
    });
  }
};

describe("tenantsUnderPreviousMaster", () => {
  it("names the tenants not forgotten with a version under another master key, in order", async () => {
    const store = createMemoryTenantKeyStore();
    const first = await masterOf("FIRST");
    await tenantsIn(store, first, ["globex", "acme", "initech"]);
    const record = await store.get("initech");
    if (record === null) throw new Error("no record");
    await store.put(
      "initech",
      { ...record, keys: [], forgotten: { at: "2026-01-01", eventId: "e-1" } },
      record.revision,
    );
    const second = await masterOf("SECOND", ["FIRST"]);
    expect(await tenantsUnderPreviousMaster({ store, master: second })).toEqual(["acme", "globex"]);
    expect(await tenantsUnderPreviousMaster({ store, master: first })).toEqual([]);
  });

  it("passes over a tenant whose record went between the listing and its reading", async () => {
    const store = createMemoryTenantKeyStore();
    await tenantsIn(store, await masterOf("FIRST"), ["acme"]);
    const gone: TenantKeyStore = { ...store, get: async () => null };
    expect(
      await tenantsUnderPreviousMaster({ store: gone, master: await masterOf("SECOND") }),
    ).toEqual([]);
  });

  it("goes through every page of the store", async () => {
    const store = createMemoryTenantKeyStore();
    const first = await masterOf("FIRST");
    const many = Array.from({ length: 501 }, (_, index) => `t-${String(index).padStart(3, "0")}`);
    const [one] = many;
    await tenantsIn(store, first, [one ?? ""]);
    const record = await store.get(one ?? "");
    if (record === null) throw new Error("no record");
    const { revision: _, ...copy } = record;
    for (const tenant of many.slice(1)) await store.put(tenant, copy, null);
    const second = await masterOf("SECOND", ["FIRST"]);
    expect(await tenantsUnderPreviousMaster({ store, master: second })).toHaveLength(501);
  });
});

describe("rewrapRecordUnderMaster", () => {
  it("rewraps every version under the master key in force, and nothing twice", async () => {
    const store = createMemoryTenantKeyStore();
    await tenantsIn(store, await masterOf("FIRST"), ["acme"]);
    const second = await masterOf("SECOND", ["FIRST"]);
    expect(await rewrapRecordUnderMaster({ store, master: second, tenant: "acme" })).toBe(1);
    expect((await store.get("acme"))?.keys.map(({ wrappedBy }) => wrappedBy)).toEqual([second.kid]);
    expect(await rewrapRecordUnderMaster({ store, master: second, tenant: "acme" })).toBe(0);
    expect(await rewrapRecordUnderMaster({ store, master: second, tenant: "nobody" })).toBe(0);
  });

  it("refuses a version under a master key it does not know, or that unwraps to another key", async () => {
    const store = createMemoryTenantKeyStore();
    await tenantsIn(store, await masterOf("FIRST"), ["acme"]);
    const stranger = await masterOf("SECOND");
    await expect(
      rewrapRecordUnderMaster({ store, master: stranger, tenant: "acme" }),
    ).rejects.toThrow("which is neither the key wrapper's key nor one of its previous ones");
    const record = await store.get("acme");
    if (record === null) throw new Error("no record");
    const [version] = record.keys;
    if (version === undefined) throw new Error("no version");
    await store.put("acme", { ...record, keys: [{ ...version, fingerprint: "x" }] }, 1);
    await expect(
      rewrapRecordUnderMaster({
        store,
        master: await masterOf("SECOND", ["FIRST"]),
        tenant: "acme",
      }),
    ).rejects.toThrow("does not match its fingerprint");
  });

  it("reads again a record another writer changed, and gives up on one that keeps changing", async () => {
    const store = createMemoryTenantKeyStore();
    await tenantsIn(store, await masterOf("FIRST"), ["acme"]);
    const second = await masterOf("SECOND", ["FIRST"]);
    let losses = 1;
    const racing: TenantKeyStore = {
      ...store,
      put: async (tenant, record, expected) => {
        if (losses > 0) {
          losses -= 1;
          return false;
        }
        return store.put(tenant, record, expected);
      },
    };
    expect(await rewrapRecordUnderMaster({ store: racing, master: second, tenant: "acme" })).toBe(
      1,
    );
    await tenantsIn(store, await masterOf("FIRST"), ["globex"]);
    let puts = 0;
    const losing: TenantKeyStore = {
      ...store,
      put: async () => {
        puts += 1;
        return false;
      },
    };
    await expect(
      rewrapRecordUnderMaster({ store: losing, master: second, tenant: "globex" }),
    ).rejects.toThrow(
      new ConfigurationError(
        "The record of tenant globex's key kept changing while it was rewrapped",
      ),
    );
    expect(puts).toBe(5);
  });
});

describe("rewrapTenantKeys", () => {
  const directory = mkdtempSync(join(tmpdir(), "bounda-master-rotation-"));
  const storage = createNodeSqliteAdapter(join(directory, "app.db")).adapter;
  const keysAt = join(directory, "keys.db");

  it("rewraps the key of every tenant the store holds, and leaves the ones it cannot", async () => {
    const keys = createNodeSqliteAdapter(keysAt).adapter;
    const store = await keys.createTenantKeyStore();
    await tenantsIn(store, await masterOf("FIRST"), ["acme", "globex"]);
    const record = await store.get("globex");
    if (record === null) throw new Error("no record");
    const [version] = record.keys;
    if (version === undefined) throw new Error("no version");
    await store.put(
      "initech",
      { store: "s-9", keys: [{ ...version, wrappedBy: "unknown" }], forgotten: null },
      null,
    );
    await store.close?.();
    const config = {
      storage,
      runtime: {
        personalData: {
          keyWrapper: masterKey({ from: "SECOND", previous: ["FIRST"] }),
          tenantKeys: createNodeSqliteAdapter(keysAt).adapter,
        },
      },
    };
    const result = await rewrapTenantKeys({ config, env });
    expect(result.rewrapped).toEqual(["acme", "globex"]);
    expect(result.left.map(({ tenant }) => tenant)).toEqual(["initech"]);
    expect(await rewrapTenantKeys({ config, env })).toMatchObject({ rewrapped: [] });
  });

  it("needs a key wrapper and a tenant key store", async () => {
    const refusal = new ConfigurationError(
      "Rewrapping the tenants' keys needs runtime.personalData.keyWrapper and runtime.personalData.tenantKeys",
    );
    for (const personalData of [
      {},
      { keyWrapper: masterKey({ from: "FIRST" }) },
      { tenantKeys: createNodeSqliteAdapter(keysAt).adapter },
    ]) {
      const config = { storage, runtime: { personalData } };
      await expect(rewrapTenantKeys({ config, env })).rejects.toThrow(refusal);
      await expect(listTenantsUnderPreviousMaster({ config, env })).rejects.toThrow(refusal);
    }
  });

  it("refuses a store each tenant's record of which one writer alone may write, as KV", async () => {
    const records = createMemoryTenantKeyStore();
    const config = {
      storage,
      runtime: {
        personalData: {
          keyWrapper: masterKey({ from: "SECOND", previous: ["FIRST"] }),
          tenantKeys: defineTenantKeyStore(() => ({ ...records, oneWriterPerTenant: true })),
        },
      },
    };
    await expect(rewrapTenantKeys({ config, env })).rejects.toThrow(
      new ConfigurationError(
        "The tenant key store is written by each tenant's own writer alone, as KV is: rewrap each tenant there, as createWorker's scheduled does on Cloudflare",
      ),
    );
    expect(await listTenantsUnderPreviousMaster({ config, env })).toEqual([]);
  });

  it("names the tenants left, counts none another writer rewrapped first, and closes the store", async () => {
    const records = createMemoryTenantKeyStore();
    await tenantsIn(records, await masterOf("FIRST"), ["acme", "globex"]);
    const second = await masterOf("SECOND", ["FIRST"]);
    let closed = 0;
    let reads = 0;
    // Another instance rewraps globex between this one's listing and its rewrap.
    const racing: TenantKeyStore = {
      ...records,
      get: async (tenant) => {
        if (tenant === "globex") {
          reads += 1;
          if (reads === 2)
            await rewrapRecordUnderMaster({ store: records, master: second, tenant });
        }
        return records.get(tenant);
      },
      close: async () => {
        closed += 1;
      },
    };
    const config = {
      storage,
      runtime: {
        personalData: {
          keyWrapper: masterKey({ from: "SECOND", previous: ["FIRST"] }),
          tenantKeys: defineTenantKeyStore(() => racing),
        },
      },
    };
    expect(await listTenantsUnderPreviousMaster({ config, env })).toEqual(["acme", "globex"]);
    expect(closed).toBe(1);
    reads = 0;
    expect(await rewrapTenantKeys({ config, env })).toEqual({ rewrapped: ["acme"], left: [] });
    expect(closed).toBe(2);
    expect(await listTenantsUnderPreviousMaster({ config, env })).toEqual([]);
  });
});
