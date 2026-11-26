import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import type { Config, ProjectConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenancyStore } from "../../memory/tenancy-store.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { toBase64 } from "./crypto.ts";
import { defineForgetLedger } from "./forget-ledger.ts";
import { buildKeyWrapper, type CryptoKeyWrapper, defineCryptoKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import {
  listTenantsUnderPreviousMaster,
  rewrapRecordUnderMaster,
  rewrapTenantKeys,
  tenantsUnderPreviousMaster,
} from "./master-rotation.ts";
import { defineTenantKeyStore, type TenantKeySource } from "./tenant-key-source.ts";
import { DEFAULT_TENANT, openTenantKeys } from "./tenant-keys.ts";

const env = {
  FIRST: toBase64(crypto.getRandomValues(new Uint8Array(32))),
  SECOND: toBase64(crypto.getRandomValues(new Uint8Array(32))),
  THIRD: toBase64(crypto.getRandomValues(new Uint8Array(32))),
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
    let racing = false;
    // Another instance rewraps globex between this one's listing and its rewrap.
    const store: TenantKeyStore = {
      ...records,
      get: async (tenant) => {
        if (racing && tenant === "globex") {
          racing = false;
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
          tenantKeys: defineTenantKeyStore(() => store),
        },
      },
    };
    expect(await listTenantsUnderPreviousMaster({ config, env })).toEqual(["acme", "globex"]);
    expect(closed).toBe(1);
    racing = true;
    expect(await rewrapTenantKeys({ config, env })).toEqual({
      rewrapped: ["acme"],
      left: [],
      unreached: [],
    });
    // Once to list it, once to rewrap what it lists.
    expect(closed).toBe(3);
    expect(await listTenantsUnderPreviousMaster({ config, env })).toEqual([]);
  });
});

describe("rewrapTenantKeys across every store a configuration that is a function of the tenant names", () => {
  type PersonalData = NonNullable<NonNullable<Config["runtime"]>["personalData"]>;
  const configWith = (personalData: PersonalData): Config => ({
    storage: memory(),
    runtime: { personalData },
  });
  const keysIn = (store: TenantKeyStore): TenantKeySource => defineTenantKeyStore(() => store);
  const second = masterKey({ from: "SECOND", previous: ["FIRST"] });
  const wrappers = async (store: TenantKeyStore, tenant: string) =>
    (await store.get(tenant))?.keys.map(({ wrappedBy }) => wrappedBy);
  const entryOf = (tenant: string): ForgetLedgerEntry => ({
    personId: `${tenant}-p`,
    categories: null,
    eventId: `${tenant}-e`,
    forgottenAt: "2026-03-01T00:00:00.000Z",
    reason: "requested",
  });
  // A record of the tenant under a master key no key wrapper knows.
  const unknownIn = async (store: TenantKeyStore, tenant: string): Promise<void> => {
    await tenantsIn(store, await masterOf("FIRST"), [tenant]);
    const record = await store.get(tenant);
    if (record === null) throw new Error("no record");
    const { revision, ...current } = record;
    const keys = current.keys.map((version) => ({ ...version, wrappedBy: "unknown" }));
    await store.put(tenant, { ...current, keys }, revision);
  };

  it("rewraps every tenant of every store it reaches, each under its own configuration's master key", async () => {
    const first = await masterOf("FIRST");
    const [shared, own, named] = [
      createMemoryTenantKeyStore(),
      createMemoryTenantKeyStore(),
      createMemoryTenantKeyStore(),
    ];
    await tenantsIn(shared, first, ["acme"]);
    // A copy of acme's key in a store only globex's configuration names now.
    await tenantsIn(own, first, ["globex", "acme"]);
    await tenantsIn(named, first, ["initech"]);
    // Nothing lists globex but the forget ledger.
    const ledger = memory();
    await (await ledger.createForgetLedger({ tenant: "globex" })).append([entryOf("globex")]);
    const [sharedKeys, ownKeys, namedKeys] = [keysIn(shared), keysIn(own), keysIn(named)];
    const third = masterKey({ from: "THIRD", previous: ["FIRST"] });
    const config: ProjectConfig = ({ tenant }) =>
      tenant === "globex"
        ? configWith({ keyWrapper: third, tenantKeys: ownKeys })
        : tenant === "initech"
          ? configWith({ keyWrapper: second, tenantKeys: namedKeys })
          : configWith({
              keyWrapper: second,
              tenantKeys: sharedKeys,
              forgetLedger: { store: ledger },
            });
    expect(await rewrapTenantKeys({ config, env })).toEqual({
      rewrapped: ["acme", "globex"],
      left: [],
      unreached: [],
    });
    const [secondKid, thirdKid] = [
      (await masterOf("SECOND")).kid,
      (await buildKeyWrapper({ definition: third, env })).kid,
    ];
    expect(await wrappers(shared, "acme")).toEqual([secondKid]);
    expect(await wrappers(own, "globex")).toEqual([thirdKid]);
    expect(await wrappers(own, "acme")).toEqual([secondKid]);
    // A store only a tenant nothing lists names is reached through the tenants export.
    expect(await wrappers(named, "initech")).toEqual([first.kid]);
    expect(await rewrapTenantKeys({ config, env, tenants: ["initech"] })).toEqual({
      rewrapped: ["initech"],
      left: [],
      unreached: [],
    });
    expect(await wrappers(named, "initech")).toEqual([secondKid]);
    expect(await rewrapTenantKeys({ config, env, tenants: ["initech"] })).toEqual({
      rewrapped: [],
      left: [],
      unreached: [],
    });
  });

  it("opens a forget ledger's definition once, as the first tenant that names it opens it", async () => {
    const first = await masterOf("FIRST");
    const shared = createMemoryTenantKeyStore();
    await tenantsIn(shared, first, ["acme"]);
    const ledger = memory();
    const opened: string[] = [];
    // Opens for the default tenant alone, as one whose environment lacks what it needs elsewhere.
    const definition = defineForgetLedger(({ tenant }) => {
      opened.push(tenant);
      if (tenant !== DEFAULT_TENANT) throw new Error(`no ledger for ${tenant}`);
      return ledger.createForgetLedger({ tenant });
    });
    const config: ProjectConfig = () =>
      configWith({
        keyWrapper: second,
        tenantKeys: keysIn(shared),
        forgetLedger: { store: definition },
      });
    expect(await rewrapTenantKeys({ config, env })).toEqual({
      rewrapped: ["acme"],
      left: [],
      unreached: [],
    });
    expect(opened).toEqual([DEFAULT_TENANT]);
  });

  it("reads a database that holds both a forget ledger and tenant keys as both", async () => {
    const both = join(mkdtempSync(join(tmpdir(), "bounda-master-rotation-")), "both.db");
    const bothAdapter = () => createNodeSqliteAdapter(both).adapter;
    const first = await masterOf("FIRST");
    const keys = await bothAdapter().createTenantKeyStore();
    await tenantsIn(keys, first, ["acme"]);
    await keys.close?.();
    const ledger = await bothAdapter().createForgetLedger({ tenant: "globex" });
    await ledger.append([entryOf("globex")]);
    await ledger.close?.();
    // Only the ledger in that database lists globex, whose key is in a store of its own.
    const own = createMemoryTenantKeyStore();
    await tenantsIn(own, first, ["globex"]);
    const ownKeys = keysIn(own);
    const config: ProjectConfig = ({ tenant }) =>
      tenant === "globex"
        ? configWith({ keyWrapper: second, tenantKeys: ownKeys })
        : configWith({
            keyWrapper: second,
            tenantKeys: bothAdapter(),
            forgetLedger: { store: bothAdapter() },
          });
    expect(await rewrapTenantKeys({ config, env })).toEqual({
      rewrapped: ["acme", "globex"],
      left: [],
      unreached: [],
    });
  });

  it("goes on past a tenant it cannot rewrap or reach, and names it", async () => {
    const first = await masterOf("FIRST");
    const shared = createMemoryTenantKeyStore();
    await tenantsIn(shared, first, [
      "broken",
      "keyless",
      "stranger",
      "unledgered",
      "unlisting",
      "unwrapped",
      "vanished",
    ]);
    await tenantsIn(shared, first, ["forgotten"]);
    const record = await shared.get("forgotten");
    if (record === null) throw new Error("no record");
    const { revision, ...current } = record;
    await shared.put(
      "forgotten",
      { ...current, keys: [], forgotten: { at: "2026-01-01", eventId: "e-1" } },
      revision,
    );
    // Written by each tenant's own writer alone, as KV is.
    const kv = createMemoryTenantKeyStore();
    await tenantsIn(kv, first, ["kvtenant"]);
    await tenantsIn(kv, await masterOf("SECOND"), ["fresh"]);
    await tenantsIn(kv, first, ["kvvanished"]);
    // A record gone between the listing and its reading.
    const vanishing = (store: TenantKeyStore): TenantKeyStore => ({
      ...store,
      get: async (tenant) => (tenant.endsWith("vanished") ? null : store.get(tenant)),
    });
    const kvKeys = defineTenantKeyStore(() => ({ ...vanishing(kv), oneWriterPerTenant: true }));
    // Opened once to be listed, then down.
    const flaky = createMemoryTenantKeyStore();
    await tenantsIn(flaky, first, ["flaky", "stranger"]);
    const flakyDown = new Error("the flaky store is down");
    let flakyOpened = 0;
    const flakyKeys = defineTenantKeyStore(() => {
      flakyOpened += 1;
      if (flakyOpened > 1) throw flakyDown;
      return flaky;
    });
    const broken = new Error("no configuration for broken");
    const ledgerDown = new Error("the ledger is down");
    const noKey = new Error("no master key");
    const sharedKeys = keysIn(vanishing(shared));
    // A ledger of your own that cannot list its tenants only reaches none.
    const { tenants: _, ...unlistedLedger } = await memory().createForgetLedger({
      tenant: "unlisting",
    });
    const config: ProjectConfig = ({ tenant }) => {
      switch (tenant) {
        case "broken":
          throw broken;
        case "unledgered":
          return configWith({
            keyWrapper: second,
            tenantKeys: sharedKeys,
            forgetLedger: {
              store: defineForgetLedger(() => {
                throw ledgerDown;
              }),
            },
          });
        case "unwrapped":
          return configWith({
            keyWrapper: defineCryptoKeyWrapper(async () => {
              throw noKey;
            }),
            tenantKeys: sharedKeys,
          });
        case "unlisting":
          return configWith({
            keyWrapper: second,
            tenantKeys: sharedKeys,
            forgetLedger: { store: defineForgetLedger(() => unlistedLedger) },
          });
        case "keyless":
        case "forgotten":
        case "vanished":
          return configWith({});
        case "stranger":
          return configWith({ keyWrapper: masterKey({ from: "SECOND" }), tenantKeys: sharedKeys });
        case "kvtenant":
        case "kvvanished":
        case "fresh":
          return configWith({ keyWrapper: second, tenantKeys: kvKeys });
        case "flaky":
          return configWith({ keyWrapper: second, tenantKeys: flakyKeys });
        case DEFAULT_TENANT:
          return configWith({ keyWrapper: second, tenantKeys: sharedKeys });
        default:
          throw new Error(`no configuration for ${tenant}`);
      }
    };
    const result = await rewrapTenantKeys({ config, env, tenants: ["kvtenant", "flaky"] });
    expect(result.rewrapped).toEqual(["unledgered", "unlisting"]);
    expect(result.left.map(({ tenant }) => tenant)).toEqual([
      "flaky",
      "keyless",
      "kvtenant",
      "stranger",
      "unwrapped",
    ]);
    const errorOf = (tenant: string) => result.left.find((each) => each.tenant === tenant)?.error;
    expect(errorOf("flaky")).toBe(flakyDown);
    expect(String(errorOf("keyless"))).toContain(
      "Tenant keyless's key is wrapped under a master key, and its configuration names no runtime.personalData.keyWrapper to rewrap it under",
    );
    expect(String(errorOf("kvtenant"))).toContain(
      "The tenant key store is written by each tenant's own writer alone",
    );
    // The first store's refusal, not the one of a store read later.
    expect(String(errorOf("stranger"))).toContain(
      "which is neither the key wrapper's key nor one of its previous ones",
    );
    expect(errorOf("unwrapped")).toBe(noKey);
    expect(result.unreached).toEqual([
      { tenant: "broken", error: broken },
      { tenant: "unledgered", error: ledgerDown },
    ]);
    expect(await wrappers(shared, "broken")).toEqual([first.kid]);
  });

  it("starts from the tenant named, and rejects when that tenant's stores cannot be read", async () => {
    const store = createMemoryTenantKeyStore();
    await tenantsIn(store, await masterOf("FIRST"), ["acme"]);
    const acmeKeys = keysIn(store);
    // Any tenant but these two has no configuration, so none is reached beside what acme lists.
    const config: ProjectConfig = ({ tenant }) => {
      if (tenant === "acme") return configWith({ keyWrapper: second, tenantKeys: acmeKeys });
      if (tenant === DEFAULT_TENANT) return { storage: memory() };
      throw new Error(`no configuration for ${tenant}`);
    };
    await expect(rewrapTenantKeys({ config, env })).rejects.toThrow(
      "Rewrapping the tenants' keys needs runtime.personalData.keyWrapper and runtime.personalData.tenantKeys",
    );
    expect(await rewrapTenantKeys({ config, env, tenant: "acme" })).toEqual({
      rewrapped: ["acme"],
      left: [],
      unreached: [],
    });
    const down = new Error("the store is down");
    const failing = defineTenantKeyStore(() => {
      throw down;
    });
    await expect(
      rewrapTenantKeys({ config: configWith({ keyWrapper: second, tenantKeys: failing }), env }),
    ).rejects.toBe(down);
    const ledgerDown = new Error("the ledger is down");
    const unledgered = configWith({
      keyWrapper: second,
      tenantKeys: acmeKeys,
      forgetLedger: {
        store: defineForgetLedger(() => {
          throw ledgerDown;
        }),
      },
    });
    await expect(rewrapTenantKeys({ config: unledgered, env })).rejects.toBe(ledgerDown);
    await expect(
      rewrapTenantKeys({ config: configWith({ keyWrapper: second }), env, tenant: "" }),
    ).rejects.toThrow("The tenant is named with an empty string");
    const noKey = new Error("no master key");
    await expect(
      rewrapTenantKeys({
        config: configWith({
          keyWrapper: defineCryptoKeyWrapper(async () => {
            throw noKey;
          }),
          tenantKeys: failing,
        }),
        env,
      }),
    ).rejects.toBe(noKey);
  });

  it("builds each key wrapper once, and names the tenants in code-unit order across stores", async () => {
    let built = 0;
    const counted = defineCryptoKeyWrapper(async (args) => {
      built += 1;
      return buildKeyWrapper({ definition: second, ...args });
    });
    const [one, two] = [createMemoryTenantKeyStore(), createMemoryTenantKeyStore()];
    const first = await masterOf("FIRST");
    await tenantsIn(one, first, ["b"]);
    await unknownIn(one, "z");
    await tenantsIn(two, first, ["a"]);
    await unknownIn(two, "Y");
    const [oneKeys, twoKeys] = [keysIn(one), keysIn(two)];
    const config: ProjectConfig = ({ tenant }) =>
      configWith({ keyWrapper: counted, tenantKeys: tenant === "a" ? twoKeys : oneKeys });
    const result = await rewrapTenantKeys({ config, env, tenants: ["a"] });
    expect(result.rewrapped).toEqual(["a", "b"]);
    expect(result.left.map(({ tenant }) => tenant)).toEqual(["Y", "z"]);
    expect(built).toBe(1);
  });
});
