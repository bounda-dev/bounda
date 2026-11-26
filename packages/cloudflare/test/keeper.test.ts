import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ConfigurationError,
  createApp,
  type DataLocation,
  FORGET_LEDGER_GRACE_MS,
  type PersonalDataForgottenPayload,
  personalDataInventory,
  type TenantExportPart,
} from "@bounda-dev/core";
import type { TenantKeyRecord, TenantKeyStore } from "@bounda-dev/core/adapter";
import { forgetLedgerContract, tenantKeyStoreContract } from "@bounda-dev/core/adapter/testing";
import {
  type Config,
  defineForgetLedger,
  defineTenantKeyStore,
  masterKey,
} from "@bounda-dev/core/config";
import { memory } from "@bounda-dev/core/memory";
import { describe, expect, it, vi } from "vitest";
import { configForObject } from "../src/bounda-object.ts";
import { connect } from "../src/client.ts";
import { cloudflare, cloudflareStorageOf } from "../src/definition.ts";
import { kvForgetLedger } from "../src/forget-ledger.ts";
import { keeperJurisdictions } from "../src/keeper.ts";
import {
  DEFAULT_KEEPER_BINDING,
  durableObjectForgetLedger,
  durableObjectTenantKeys,
} from "../src/keeper-stores.ts";
import { kvTenantKeys } from "../src/tenant-keys.ts";
import { inWorkerRuntime, LEDGER_IN_OBJECT, ROTATE_IN_WORKER } from "../src/worker-runtime.ts";
import { quietRegistry } from "./app.ts";
import { clock } from "./clock.ts";
import { keptConfig, keptWorker } from "./test-worker.ts";

const storage = cloudflare();
const eu = cloudflare({ jurisdiction: "eu" });

let runs = 0;
// Every test of the contracts on a tenant of its own, as a fresh store has.
const fresh = (): string => {
  runs += 1;
  return `run-${runs}-`;
};

const record = (store: string): TenantKeyRecord => ({
  store,
  keys: [
    {
      kid: "t-1",
      fingerprint: "fp",
      key: "wrapped",
      wrappedBy: "m-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  forgotten: null,
});

const keeper = (name: string) => env.KEEPER.get(env.KEEPER.idFromName(name));

// Workerd keeps every keeper from one test to the next: each store of the contracts sees its own
// tenants alone, under a name of its own in the one directory.
const apart = (store: TenantKeyStore, prefix: string): TenantKeyStore => ({
  get: (tenant) => store.get(`${prefix}${tenant}`),
  put: (tenant, held, expected) => store.put(`${prefix}${tenant}`, held, expected),
  remove: (tenant, expected) => store.remove(`${prefix}${tenant}`, expected),
  list: async ({ cursor, limit }) => {
    const page = await store.list({ cursor: `${prefix}${cursor ?? ""}`, limit });
    const tenants = page.tenants
      .filter((tenant) => tenant.startsWith(prefix))
      .map((tenant) => tenant.slice(prefix.length));
    return {
      tenants,
      cursor:
        tenants.length < page.tenants.length || page.cursor === null
          ? null
          : (tenants.at(-1) ?? null),
    };
  },
});

// When a mark the tests raise was raised.
const MARKED_AT = "2026-01-01T00:00:00.000Z";

describe("the tenant key store in keeper objects", () => {
  tenantKeyStoreContract({
    create: async () => apart(await durableObjectTenantKeys({ storage }).create({ env }), fresh()),
  });

  it("keeps each tenant's record in a keeper of its own, and lists the tenant in the directory before it", async () => {
    const tenant = `${fresh()}acme`;
    const store = await durableObjectTenantKeys({ storage }).create({ env });
    expect(await store.put(tenant, record("s-1"), null)).toBe(true);
    expect(await store.put(tenant, record("s-2"), 1)).toBe(true);
    const kept = await runInDurableObject(keeper(`tenant:${tenant}`), (_object, state) =>
      state.storage.sql.exec(`SELECT "tenant", "revision" FROM "bounda_tenant_keys"`).toArray(),
    );
    expect(kept).toEqual([{ tenant, revision: 2 }]);
    const listed = await runInDurableObject(keeper("directory"), (_object, state) =>
      state.storage.sql.exec(`SELECT "tenant" FROM "bounda_keeper_tenants"`).toArray(),
    );
    expect(listed).toContainEqual({ tenant });
    expect(store.oneWriterPerTenant).toBeUndefined();
  });

  it("removes a tenant's record from its keeper and the directory, the record gone though the directory fails to unlist it", async () => {
    const listed = (tenant: string) =>
      runInDurableObject(keeper("directory"), (_object, state) =>
        state.storage.sql
          .exec(`SELECT "tenant" FROM "bounda_keeper_tenants" WHERE "tenant" = ?`, tenant)
          .toArray(),
      );
    const tenant = `${fresh()}gone`;
    const store = await durableObjectTenantKeys({ storage }).create({ env });
    await store.put(tenant, record("s-1"), null);
    expect(await store.remove(tenant, 2)).toBe(false);
    expect(await store.remove(tenant, 1)).toBe(true);
    expect(await store.get(tenant)).toBeNull();
    expect(await listed(tenant)).toEqual([]);

    const directoryId = env.KEEPER.idFromName("directory");
    const real = env.KEEPER.get(directoryId);
    const failing = {
      idFromName: (name: string) => env.KEEPER.idFromName(name),
      get: (id: DurableObjectId) =>
        id.equals(directoryId)
          ? {
              registerTenant: (name: string) => real.registerTenant(name),
              listTenants: (args: { cursor: string | null; limit: number }) =>
                real.listTenants(args),
              unregisterTenant: async () => {
                throw new Error("directory unavailable");
              },
            }
          : env.KEEPER.get(id),
    };
    const unlisting = await durableObjectTenantKeys({ storage }).create({
      env: { ...env, KEEPER: failing as unknown as typeof env.KEEPER },
    });
    const kept = `${fresh()}kept`;
    await unlisting.put(kept, record("s-1"), null);
    expect(await unlisting.remove(kept, 1)).toBe(true);
    expect(await unlisting.get(kept)).toBeNull();
    expect(await listed(kept)).toEqual([{ tenant: kept }]);
  });

  it("lists a tenant whose first record was refused, and none whose record it never asked for", async () => {
    const prefix = fresh();
    const store = await durableObjectTenantKeys({ storage }).create({ env });
    await store.put(`${prefix}a`, record("s-1"), null);
    expect(await store.put(`${prefix}a`, record("s-2"), null)).toBe(false);
    await store.put(`${prefix}b`, record("s-1"), null);
    const tenants: string[] = [];
    for (let cursor: string | null = null; ; ) {
      const page = await store.list({ cursor, limit: 1 });
      tenants.push(...page.tenants);
      if (page.cursor === null) break;
      cursor = page.cursor;
    }
    expect(tenants.filter((tenant) => tenant.startsWith(prefix))).toEqual([
      `${prefix}a`,
      `${prefix}b`,
    ]);
  });

  it("is kept where its storage says, and in the keeper it names", async () => {
    expect(durableObjectTenantKeys({ storage: eu }).location).toBe("eu");
    expect(durableObjectTenantKeys({ storage }).location).toBeUndefined();
    expect(DEFAULT_KEEPER_BINDING).toBe("KEEPER");
    const tenant = `${fresh()}eu`;
    const store = await durableObjectTenantKeys({ storage: eu, binding: "EU_KEEPER" }).create({
      env,
    });
    expect(await store.put(tenant, record("s-1"), null)).toBe(true);
    expect(await store.get(tenant)).toEqual({ ...record("s-1"), revision: 1 });
    expect(await (await durableObjectTenantKeys({ storage }).create({ env })).get(tenant)).toBe(
      null,
    );
  });
});

describe("a keeper store in another jurisdiction than storage's", () => {
  it("is kept in the jurisdiction it names, under its safeguard, and works where workerd has none", async () => {
    const keys = durableObjectTenantKeys({
      storage: eu,
      binding: "EU_KEEPER",
      jurisdiction: "us",
      safeguard: "adequacy",
    });
    expect([keys.location, keys.safeguard]).toEqual(["us", "adequacy"]);
    const ledger = durableObjectForgetLedger({ storage, jurisdiction: "eu" });
    expect(ledger.location).toBe("eu");
    expect(ledger).not.toHaveProperty("safeguard");
    expect(durableObjectTenantKeys({ storage })).not.toHaveProperty("location");
    expect(durableObjectTenantKeys({ storage })).not.toHaveProperty("safeguard");
    const tenant = `${fresh()}abroad`;
    const store = await keys.create({ env });
    expect(await store.put(tenant, record("s-1"), null)).toBe(true);
    expect(await store.get(tenant)).toEqual({ ...record("s-1"), revision: 1 });
  });

  it("reads each store's jurisdiction from its location, storage's for one that names none", () => {
    const split = durableObjectTenantKeys({
      storage: eu,
      jurisdiction: "us",
      safeguard: "adequacy",
    });
    expect(
      keeperJurisdictions(
        {
          storage: eu,
          runtime: {
            personalData: {
              tenantKeys: split,
              forgetLedger: { store: durableObjectForgetLedger({ storage: eu }) },
            },
          },
        },
        "eu",
      ),
    ).toEqual({ keys: "us", ledger: "eu" });
    expect(
      keeperJurisdictions(
        {
          storage: eu,
          runtime: {
            personalData: { forgetLedger: { store: { location: "fedramp" } as never } },
          },
        },
        "eu",
      ),
    ).toEqual({ keys: "eu", ledger: "fedramp" });
    // A store that names no place, or a configuration a Worker's code holds as null, is storage's.
    for (const runtime of [
      undefined,
      null,
      { personalData: null },
      { personalData: { tenantKeys: null } },
    ]) {
      expect(keeperJurisdictions({ storage, runtime } as unknown as Config, undefined)).toEqual({
        keys: undefined,
        ledger: undefined,
      });
    }
    expect(
      keeperJurisdictions(
        { storage, runtime: { personalData: { tenantKeys: { location: 7 } as never } } },
        "us",
      ),
    ).toEqual({ keys: "us", ledger: "us" });
  });

  it("refuses a jurisdiction that is none of Cloudflare's, and a safeguard without a jurisdiction", () => {
    for (const jurisdiction of ["", 7, "de", "EU", "global"]) {
      expect(() =>
        durableObjectTenantKeys({ storage: eu, jurisdiction: jurisdiction as never }),
      ).toThrow(
        `durableObjectTenantKeys() names a Durable Object jurisdiction, one of "eu", "us", "fedramp", "fedramp-high", not ${JSON.stringify(jurisdiction)}`,
      );
    }
    expect(() =>
      durableObjectForgetLedger({ storage: eu, safeguard: "adequacy" } as never),
    ).toThrow(
      "durableObjectForgetLedger() declares a safeguard and no jurisdiction: a safeguard allows keeping the keepers in another jurisdiction than storage's, so name it beside the safeguard",
    );
  });

  it("answers each store's calls only in that store's jurisdiction", async () => {
    const tenant = `${fresh()}split`;
    const refused = (jurisdiction: string) => ({
      ok: false,
      refusal: {
        name: "ConfigurationError",
        code: "INVALID_CONFIGURATION",
        message: `This keeper Durable Object was created in no jurisdiction, and the store it answers for is kept in jurisdiction ${jurisdiction}: the keys and ledger entries it holds never leave where it was created. Reach it through durableObjectTenantKeys() and durableObjectForgetLedger() alone`,
      },
    });
    const split = env.UNBOUND_SPLIT_KEEPER.get(
      env.UNBOUND_SPLIT_KEEPER.idFromName(`tenant:${tenant}`),
    );
    expect(await split.getTenantKeys(tenant)).toEqual(refused("us"));
    expect(await split.readLedger(tenant, { limit: 1 })).toEqual(refused("eu"));
    const directory = env.UNBOUND_SPLIT_KEEPER.get(
      env.UNBOUND_SPLIT_KEEPER.idFromName("directory"),
    );
    expect(await directory.listTenants({ cursor: null, limit: 1 })).toEqual(refused("us"));
  });
});

describe("the forget ledger in keeper objects", () => {
  forgetLedgerContract({
    create: async () => {
      const prefix = fresh();
      return async (tenant) =>
        durableObjectForgetLedger({ storage }).create({ env, tenant: `${prefix}${tenant ?? ""}` });
    },
  });

  it("keeps each tenant's entries in the tenant's keeper, and shows them at once", async () => {
    const tenant = `${fresh()}acme`;
    const ledger = await durableObjectForgetLedger({ storage }).create({ env, tenant });
    expect(ledger.visibilityDelayMs).toBeUndefined();
    const entry = {
      personId: "c-1",
      categories: null,
      eventId: "e-1",
      forgottenAt: "2026-01-01T00:00:00.000Z",
      reason: "requested" as const,
    };
    await ledger.append([entry]);
    expect(await ledger.read({ limit: 10 })).toEqual([entry]);
    const kept = await runInDurableObject(keeper(`tenant:${tenant}`), (_object, state) =>
      state.storage.sql.exec(`SELECT "tenant", "person" FROM "bounda_forget_ledger"`).toArray(),
    );
    expect(kept).toEqual([{ tenant, person: "c-1" }]);
    expect(durableObjectForgetLedger({ storage: eu }).location).toBe("eu");
    expect(durableObjectForgetLedger({ storage }).location).toBeUndefined();
  });

  it("removes each entry once past keepFor on the keeper's own alarm, the tenant's object asleep", async () => {
    const tenant = `${fresh()}kept-for`;
    const own = keeper(`tenant:${tenant}`);
    const at = (ms: number) => new Date(ms).toISOString();
    const entry = (eventId: string, forgottenAt: string) => ({
      personId: "c-1",
      categories: null,
      eventId,
      forgottenAt,
      reason: "requested" as const,
    });
    const now = Date.now();
    const alarm = () => runInDurableObject(own, (_object, state) => state.storage.getAlarm());
    const keptFor = await durableObjectForgetLedger({ storage }).create({
      env,
      tenant,
      keepForMs: 60_000,
    });
    // Told before the first call, the keeper has nothing to expire yet.
    expect(await keptFor.read({ limit: 10 })).toEqual([]);
    expect(await alarm()).toBeNull();
    await keptFor.append([entry("e-old", at(now - 120_000)), entry("e-new", at(now - 30_000))]);
    // Past already: armed for at once.
    expect(await alarm()).toBeLessThanOrEqual(Date.now());
    await runInDurableObject(own, (object) => object.alarm());
    expect(await keptFor.read({ limit: 10 })).toEqual([entry("e-new", at(now - 30_000))]);
    expect(await alarm()).toBe(now + 30_000);
    await keptFor.prune?.({ before: at(now) });
    expect(await alarm()).toBeNull();

    // Kept for good once keepFor is gone: no alarm, and one that fires removes nothing.
    await keptFor.append([entry("e-older", at(now - 120_000))]);
    const forGood = await durableObjectForgetLedger({ storage }).create({ env, tenant });
    expect(await forGood.readMark("m")).toEqual([]);
    expect(await alarm()).toBeNull();
    await runInDurableObject(own, (object) => object.alarm());
    expect(await forGood.read({ limit: 10 })).toEqual([entry("e-older", at(now - 120_000))]);
  });

  it("tells the keeper how long to keep the entries again after a call that failed before it", async () => {
    const tenant = `${fresh()}retried`;
    let calls = 0;
    const failing = {
      KEEPER: {
        idFromName: (name: string) => env.KEEPER.idFromName(name),
        get: (id: DurableObjectId) => {
          const stub = env.KEEPER.get(id);
          return {
            retainLedger: (...args: Parameters<typeof stub.retainLedger>) => {
              calls += 1;
              if (calls === 1) return Promise.reject(new Error("keeper unavailable"));
              return stub.retainLedger(...args);
            },
            readLedger: (...args: Parameters<typeof stub.readLedger>) => stub.readLedger(...args),
          };
        },
      },
    } as unknown as Cloudflare.Env;
    const ledger = await durableObjectForgetLedger({ storage }).create({
      env: failing,
      tenant,
      keepForMs: 1_000,
    });
    await expect(ledger.read({ limit: 1 })).rejects.toThrow("keeper unavailable");
    expect(await ledger.read({ limit: 1 })).toEqual([]);
    expect(await ledger.read({ limit: 1 })).toEqual([]);
    expect(calls).toBe(2);
  });
});

describe("the keeper stores' configuration", () => {
  it("refuses a storage that is not cloudflare(), and a binding the Worker does not have", async () => {
    const memoryStorage = { kind: "bounda-adapter", name: "memory", options: {} } as never;
    expect(() => durableObjectTenantKeys({ storage: memoryStorage })).toThrow(
      new ConfigurationError(
        "durableObjectTenantKeys() takes the app's storage, its cloudflare(), whose jurisdiction the keeper shares",
      ),
    );
    expect(() => durableObjectForgetLedger({ storage: memoryStorage })).toThrow(
      new ConfigurationError(
        "durableObjectForgetLedger() takes the app's storage, its cloudflare(), whose jurisdiction the keeper shares",
      ),
    );
    await expect(
      Promise.resolve().then(() =>
        durableObjectTenantKeys({ storage, binding: "MISSING" }).create({ env }),
      ),
    ).rejects.toThrow(
      new ConfigurationError(
        "runtime.personalData.tenantKeys names the keeper binding MISSING, which the Worker's env does not hold: bind the class createBoundaKeeper() returns under durable_objects in wrangler.jsonc",
      ),
    );
    // A binding that is null, or has idFromName but no get, is no Durable Object namespace.
    const odd = {
      NOTHING: null,
      HALF: { idFromName: () => undefined },
    } as unknown as Cloudflare.Env;
    for (const binding of ["NOTHING", "HALF"]) {
      await expect(
        Promise.resolve().then(() =>
          durableObjectTenantKeys({ storage, binding }).create({ env: odd }),
        ),
      ).rejects.toThrow(
        new ConfigurationError(
          `runtime.personalData.tenantKeys names the keeper binding ${binding}, which the Worker's env does not hold: bind the class createBoundaKeeper() returns under durable_objects in wrangler.jsonc`,
        ),
      );
    }
    for (const binding of ["MISSING", "TENANT_KEYS", "STORE_REGION"]) {
      await expect(
        Promise.resolve().then(() =>
          durableObjectForgetLedger({ storage, binding }).create({ env, tenant: "acme" }),
        ),
      ).rejects.toThrow(
        new ConfigurationError(
          `runtime.personalData.forgetLedger.store names the keeper binding ${binding}, which the Worker's env does not hold: bind the class createBoundaKeeper() returns under durable_objects in wrangler.jsonc`,
        ),
      );
    }
  });
});

describe("the stores outside a Worker", () => {
  it("refuse to open from a terminal, saying where they are opened instead", async () => {
    expect(inWorkerRuntime()).toBe(true);
    vi.stubGlobal("navigator", { userAgent: "Node.js/25" });
    try {
      expect(inWorkerRuntime()).toBe(false);
      const opening = [
        [
          () => durableObjectTenantKeys({ storage }).create({ env }),
          `runtime.personalData.tenantKeys is kept in keeper Durable Objects, which only a Worker reaches, and this runs outside one: ${ROTATE_IN_WORKER}`,
        ],
        [
          () => durableObjectForgetLedger({ storage }).create({ env, tenant: "acme" }),
          `runtime.personalData.forgetLedger.store is kept in keeper Durable Objects, which only a Worker reaches, and this runs outside one: ${LEDGER_IN_OBJECT}`,
        ],
        [
          () => kvTenantKeys({ binding: "TENANT_KEYS" }).create({ env }),
          `runtime.personalData.tenantKeys names the KV binding TENANT_KEYS, which only a Worker holds, and this runs outside one: ${ROTATE_IN_WORKER}`,
        ],
        [
          () => kvForgetLedger({ binding: "FORGET_LEDGER" }).create({ env, tenant: "acme" }),
          `runtime.personalData.forgetLedger.store names the KV binding FORGET_LEDGER, which only a Worker holds, and this runs outside one: ${LEDGER_IN_OBJECT}; bounda forget-ledger expire reaches the namespace through wrangler`,
        ],
      ] as const;
      for (const [open, message] of opening) {
        await expect((async () => open())()).rejects.toThrow(new ConfigurationError(message));
      }
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("navigator", undefined);
    try {
      expect(inWorkerRuntime()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(inWorkerRuntime()).toBe(true);
  });
});

describe("a keeper object", () => {
  it("refuses a tenant it does not keep, and the directory's work, as the directory refuses a tenant's", async () => {
    const tenant = `${fresh()}acme`;
    const other = keeper(`tenant:${tenant}-other`);
    const refusal = (kept: string) => ({
      ok: false,
      refusal: {
        name: "ConfigurationError",
        code: "INVALID_CONFIGURATION",
        message: `This keeper Durable Object keeps ${kept}, not tenant ${tenant}: reach it through durableObjectTenantKeys() and durableObjectForgetLedger() alone`,
      },
    });
    const mismatched = refusal(`"tenant:${tenant}-other"`);
    expect(await other.getTenantKeys(tenant)).toEqual(mismatched);
    expect(await other.putTenantKeys(tenant, record("s-1"), null)).toEqual(mismatched);
    expect(await other.appendLedger(tenant, [])).toEqual(mismatched);
    expect(await other.readLedger(tenant, { limit: 1 })).toEqual(mismatched);
    expect(await other.pruneLedger(tenant, { before: "2026-01-01T00:00:00.000Z" })).toEqual(
      mismatched,
    );
    expect(await other.readLedgerMark(tenant, "m")).toEqual(mismatched);
    expect(await other.raiseLedgerMark(tenant, "m", { value: 1, raisedAt: MARKED_AT })).toEqual(
      mismatched,
    );
    expect(await keeper("directory").getTenantKeys(tenant)).toEqual(refusal(`"directory"`));
    const unnamed = env.KEEPER.get(env.KEEPER.newUniqueId());
    expect(await unnamed.getTenantKeys(tenant)).toEqual(refusal("no tenant"));
    const directoryOnly = {
      ok: false,
      refusal: {
        name: "ConfigurationError",
        code: "INVALID_CONFIGURATION",
        message:
          "Only the keeper named directory lists the tenants: reach it through durableObjectTenantKeys() alone",
      },
    };
    expect(await other.registerTenant(tenant)).toEqual(directoryOnly);
    expect(await other.listTenants({ cursor: null, limit: 1 })).toEqual(directoryOnly);
    expect(await unnamed.listTenants({ cursor: null, limit: 1 })).toEqual(directoryOnly);
  });

  it("prunes the tenant's ledger and keeps its marks", async () => {
    const tenant = `${fresh()}acme`;
    const own = keeper(`tenant:${tenant}`);
    const entry = (eventId: string, forgottenAt: string) => ({
      personId: "c-1",
      categories: null,
      eventId,
      forgottenAt,
      reason: "requested" as const,
    });
    await own.appendLedger(tenant, [
      entry("e-1", "2026-01-01T00:00:00.000Z"),
      entry("e-2", "2026-02-01T00:00:00.000Z"),
    ]);
    expect(await own.pruneLedger(tenant, { before: "2026-01-15T00:00:00.000Z" })).toEqual({
      ok: true,
      value: null,
    });
    expect(await own.readLedger(tenant, { limit: 10 })).toEqual({
      ok: true,
      value: [entry("e-2", "2026-02-01T00:00:00.000Z")],
    });
    expect(await own.raiseLedgerMark(tenant, "m", { value: 3, raisedAt: MARKED_AT })).toEqual({
      ok: true,
      value: null,
    });
    expect(await own.readLedgerMark(tenant, "m")).toEqual({
      ok: true,
      value: [{ value: 3, raisedAt: MARKED_AT }],
    });
  });

  it("clears the tenant's ledger, its marks and its alarm, and keeps how long it keeps entries", async () => {
    const tenant = `${fresh()}cleared`;
    const own = keeper(`tenant:${tenant}`);
    const alarm = () => runInDurableObject(own, (_object, state) => state.storage.getAlarm());
    const entry = (eventId: string, forgottenAt: string) => ({
      personId: "c-1",
      categories: null,
      eventId,
      forgottenAt,
      reason: "requested" as const,
    });
    const now = Date.now();
    await own.retainLedger(tenant, 60_000);
    await own.appendLedger(tenant, [entry("e-1", new Date(now).toISOString())]);
    await own.raiseLedgerMark(tenant, "m", { value: 3, raisedAt: MARKED_AT });
    expect(await alarm()).toBe(now + 60_000);
    expect(await own.clearLedger(tenant)).toEqual({ ok: true, value: null });
    expect(await own.readLedger(tenant, { limit: 10 })).toEqual({ ok: true, value: [] });
    expect(await own.readLedgerMark(tenant, "m")).toEqual({ ok: true, value: [] });
    expect(await alarm()).toBeNull();
    // An entry appended after still expires on its own.
    await own.appendLedger(tenant, [entry("e-2", new Date(now).toISOString())]);
    expect(await alarm()).toBe(now + 60_000);
  });

  it("starts where workerd has no jurisdictions, as the app's binding tells, and refuses every call without it", async () => {
    const tenant = `${fresh()}acme`;
    const inEu = env.EU_KEEPER.get(env.EU_KEEPER.idFromName(`tenant:${tenant}`));
    expect(await inEu.getTenantKeys(tenant)).toEqual({ ok: true, value: null });
    const outside = {
      ok: false,
      refusal: {
        name: "ConfigurationError",
        code: "INVALID_CONFIGURATION",
        message:
          "This keeper Durable Object was created in no jurisdiction, and the store it answers for is kept in jurisdiction eu: the keys and ledger entries it holds never leave where it was created. Reach it through durableObjectTenantKeys() and durableObjectForgetLedger() alone",
      },
    };
    const unbound = env.UNBOUND_EU_KEEPER.get(env.UNBOUND_EU_KEEPER.idFromName(`tenant:${tenant}`));
    expect(await unbound.getTenantKeys(tenant)).toEqual(outside);
    expect(await unbound.readLedger(tenant, { limit: 1 })).toEqual(outside);
    const directory = env.UNBOUND_EU_KEEPER.get(env.UNBOUND_EU_KEEPER.idFromName("directory"));
    expect(await directory.listTenants({ cursor: null, limit: 1 })).toEqual(outside);
  });
});

describe("cloudflare() with a jurisdiction", () => {
  const keyWrapper = masterKey({ from: "BOUNDA_MASTER_KEY", location: "eu" });
  const refusal = (config: Config): string => {
    try {
      cloudflareStorageOf(config);
    } catch (error) {
      if (error instanceof ConfigurationError) return error.message;
      throw error;
    }
    return "resolved";
  };

  it("refuses a tenant key store or a forget ledger kept anywhere else, Workers KV first", () => {
    expect(
      refusal({
        storage: eu,
        runtime: {
          personalData: { keyWrapper, tenantKeys: kvTenantKeys({ binding: "TENANT_KEYS" }) },
        },
      }),
    ).toBe(
      'runtime.personalData.tenantKeys declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, or elsewhere under a safeguard, so use durableObjectTenantKeys({ storage }), which keeps it in jurisdiction "eu", or, as Workers KV holds what it keeps to no jurisdiction, declare location: "global" with the safeguard that allows that',
    );
    expect(
      refusal({
        storage: eu,
        runtime: {
          personalData: {
            keyWrapper,
            tenantKeys: durableObjectTenantKeys({ storage: eu }),
            forgetLedger: { store: kvForgetLedger({ binding: "FORGET_LEDGER" }) },
          },
        },
      }),
    ).toBe(
      'runtime.personalData.forgetLedger.store declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, or elsewhere under a safeguard, so use durableObjectForgetLedger({ storage }), which keeps it in jurisdiction "eu", or, as Workers KV holds what it keeps to no jurisdiction, declare location: "global" with the safeguard that allows that',
    );
    expect(
      refusal({
        storage: eu,
        runtime: {
          personalData: {
            keyWrapper,
            tenantKeys: durableObjectTenantKeys({
              storage: cloudflare({ jurisdiction: "fedramp" }),
            }),
          },
        },
      }),
    ).toBe(
      'runtime.personalData.tenantKeys keeps its data in "fedramp", in the country US, and storage keeps the app\'s in "eu", in the European Economic Area: keeping it there is a transfer, which a safeguard must allow, so declare its safeguard beside its location, one of "adequacy" (article 45), "standard-contractual-clauses" (article 46(2)(c)), "binding-corporate-rules" (article 47), "code-of-conduct" (article 46(2)(e)), "certification" (article 46(2)(f)), or keep it where the storage is and use durableObjectTenantKeys({ storage }), which keeps it in the same jurisdiction, durableObjectTenantKeys({ storage, jurisdiction, safeguard }) to keep it in another under a safeguard, or a store of your own that names where it keeps it, through defineTenantKeyStore(create, { location: "eu" })',
    );
  });

  it("takes a store kept in another jurisdiction under a safeguard, and tells the record of processing", () => {
    const usKeys = durableObjectTenantKeys({
      storage: eu,
      jurisdiction: "us",
      safeguard: "standard-contractual-clauses",
    });
    const kvLedger = kvForgetLedger({
      binding: "FORGET_LEDGER",
      location: "global",
      safeguard: "standard-contractual-clauses",
    });
    const config: Config = {
      storage: eu,
      runtime: {
        personalData: { keyWrapper, tenantKeys: usKeys, forgetLedger: { store: kvLedger } },
      },
    };
    expect(refusal(config)).toBe("resolved");
    const { records } = personalDataInventory({ registry: quietRegistry, config });
    expect(records).toContainEqual({
      name: "tenant-keys",
      where: "tenant-keys",
      location: "us",
      transfer: { safeguard: "standard-contractual-clauses", article: "46(2)(c)", regime: "US" },
      keptFor: null,
    });
    expect(records.find(({ name }) => name === "forget-ledger")).toMatchObject({
      location: "global",
      transfer: {
        safeguard: "standard-contractual-clauses",
        article: "46(2)(c)",
        regime: "anywhere",
      },
    });
    expect(
      kvTenantKeys({ binding: "TENANT_KEYS", location: "global", safeguard: "certification" }),
    ).toMatchObject({ location: "global", safeguard: "certification" });
  });

  it("refuses a keeper store elsewhere without a safeguard, or with one where storage is", () => {
    expect(
      refusal({
        storage: eu,
        runtime: {
          personalData: {
            keyWrapper,
            tenantKeys: durableObjectTenantKeys({ storage: eu, jurisdiction: "us" }),
          },
        },
      }),
    ).toBe(
      'runtime.personalData.tenantKeys keeps its data in "us", in the country US, and storage keeps the app\'s in "eu", in the European Economic Area: keeping it there is a transfer, which a safeguard must allow, so declare its safeguard beside its location, one of "adequacy" (article 45), "standard-contractual-clauses" (article 46(2)(c)), "binding-corporate-rules" (article 47), "code-of-conduct" (article 46(2)(e)), "certification" (article 46(2)(f)), or keep it where the storage is and use durableObjectTenantKeys({ storage }), which keeps it in the same jurisdiction, durableObjectTenantKeys({ storage, jurisdiction, safeguard }) to keep it in another under a safeguard, or a store of your own that names where it keeps it, through defineTenantKeyStore(create, { location: "eu" })',
    );
    expect(() =>
      personalDataInventory({
        registry: quietRegistry,
        config: {
          storage: eu,
          runtime: {
            personalData: {
              keyWrapper,
              tenantKeys: durableObjectTenantKeys({
                storage: eu,
                jurisdiction: "eu",
                safeguard: "adequacy",
              }),
            },
          },
        },
      }),
    ).toThrow(
      'runtime.personalData.tenantKeys keeps its data in "eu" under a safeguard, and storage keeps the app\'s in "eu", both in the European Economic Area, so keeping it there is no transfer: remove its safeguard',
    );
  });

  it("tells a store of your own without a location how to declare the jurisdiction", () => {
    expect(
      refusal({
        storage: eu,
        runtime: {
          personalData: {
            keyWrapper,
            forgetLedger: {
              store: defineForgetLedger(() => {
                throw new Error("never opened");
              }),
            },
          },
        },
      }),
    ).toBe(
      'runtime.personalData.forgetLedger.store declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, or elsewhere under a safeguard, so use durableObjectForgetLedger({ storage }), which keeps it in the same jurisdiction, durableObjectForgetLedger({ storage, jurisdiction, safeguard }) to keep it in another under a safeguard, or a store of your own that names where it keeps it, through defineForgetLedger(create, { location: "eu" })',
    );
  });

  it("refuses a safeguard on a keeper store when cloudflare() names no jurisdiction, in the Worker too", () => {
    expect(() =>
      cloudflareStorageOf({
        storage: cloudflare(),
        runtime: {
          personalData: {
            tenantKeys: kvTenantKeys({
              binding: "TENANT_KEYS",
              location: "global",
              safeguard: "standard-contractual-clauses",
            }),
          },
        },
      }),
    ).toThrow(
      'runtime.personalData.tenantKeys keeps its data in "global" under a safeguard, and storage declares no location, so nothing tells whether that is a transfer: declare where storage keeps the app\'s data',
    );
  });

  it("refuses a store of your own that declares a safeguard and no location", () => {
    expect(
      refusal({
        storage: eu,
        runtime: {
          personalData: {
            keyWrapper,
            tenantKeys: defineTenantKeyStore(
              () => {
                throw new Error("never opened");
              },
              { safeguard: "adequacy" } as never,
            ),
          },
        },
      }),
    ).toBe(
      "runtime.personalData.tenantKeys declares a safeguard and no location: a safeguard allows keeping data in a location, so declare where it keeps its data beside it",
    );
  });

  it("refuses a derogation, or anything that is no safeguard, before any object starts", () => {
    for (const safeguard of ["derogation", "privacy-shield"]) {
      expect(
        refusal({
          storage: eu,
          runtime: {
            personalData: {
              keyWrapper,
              forgetLedger: {
                store: durableObjectForgetLedger({
                  storage: eu,
                  jurisdiction: "us",
                  safeguard: safeguard as never,
                }),
              },
            },
          },
        }),
      ).toBe(
        safeguard === "derogation"
          ? `runtime.personalData.forgetLedger.store rests keeping its data abroad on a derogation, which article 49 allows for occasional transfers alone, never for data kept there as long as the app runs: declare one of "adequacy" (article 45), "standard-contractual-clauses" (article 46(2)(c)), "binding-corporate-rules" (article 47), "code-of-conduct" (article 46(2)(e)), "certification" (article 46(2)(f))`
          : `runtime.personalData.forgetLedger.store declares the safeguard "${safeguard}", which is none of "adequacy" (article 45), "standard-contractual-clauses" (article 46(2)(c)), "binding-corporate-rules" (article 47), "code-of-conduct" (article 46(2)(e)), "certification" (article 46(2)(f))`,
      );
    }
  });

  it("takes a store under the legal regime of the objects' jurisdiction without a safeguard", () => {
    const us = cloudflare({ jurisdiction: "us" });
    const own = (location: DataLocation) =>
      defineTenantKeyStore(
        () => {
          throw new Error("never opened");
        },
        { location },
      );
    for (const [storage, tenantKeys] of [
      [us, durableObjectTenantKeys({ storage: us, jurisdiction: "fedramp" })],
      [us, durableObjectTenantKeys({ storage: us, jurisdiction: "fedramp-high" })],
      [eu, own("de")],
      [eu, own("eea")],
      [us, own("us")],
    ] as const) {
      expect(
        refusal({
          storage,
          runtime: {
            personalData: {
              keyWrapper: masterKey({
                from: "BOUNDA_MASTER_KEY",
                location: storage.location ?? "eu",
              }),
              tenantKeys,
            },
          },
        }),
      ).toBe("resolved");
    }
    expect(
      refusal({
        storage: us,
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", location: "us" }),
            forgetLedger: {
              store: durableObjectForgetLedger({
                storage: us,
                jurisdiction: "fedramp",
                safeguard: "adequacy",
              }),
            },
          },
        },
      }),
    ).toBe(
      'runtime.personalData.forgetLedger.store keeps its data in "fedramp" under a safeguard, and storage keeps the app\'s in "us", both in the country US, so keeping it there is no transfer: remove its safeguard',
    );
  });

  it("refuses Workers KV that declares a location without the safeguard of keeping it there", () => {
    for (const declared of [
      { location: "global" },
      { safeguard: "certification" },
      { location: "eu", safeguard: "certification" },
      { location: "us", safeguard: "certification" },
    ]) {
      expect(() => kvForgetLedger({ binding: "FORGET_LEDGER", ...declared } as never)).toThrow(
        'runtime.personalData.forgetLedger.store is kept in Workers KV, which keeps and caches what it holds anywhere in the world, in no jurisdiction: declare location: "global" together with the safeguard that allows that, both or neither',
      );
      expect(() => kvTenantKeys({ binding: "TENANT_KEYS", ...declared } as never)).toThrow(
        'runtime.personalData.tenantKeys is kept in Workers KV, which keeps and caches what it holds anywhere in the world, in no jurisdiction: declare location: "global" together with the safeguard that allows that, both or neither',
      );
    }
    // Workers KV keeps what it holds anywhere, which no adequacy decision covers.
    expect(
      refusal({
        storage: eu,
        runtime: {
          personalData: {
            keyWrapper,
            tenantKeys: kvTenantKeys({
              binding: "TENANT_KEYS",
              location: "global",
              safeguard: "adequacy" as never,
            }),
          },
        },
      }),
    ).toBe(
      'runtime.personalData.tenantKeys keeps its data in "global" under the safeguard "adequacy", and no adequacy decision of the European Commission covers data kept anywhere in the world: declare one of "standard-contractual-clauses" (article 46(2)(c)), "binding-corporate-rules" (article 47), "code-of-conduct" (article 46(2)(e)), "certification" (article 46(2)(f))',
    );
  });

  it("refuses a read model on another adapter that is not kept in the jurisdiction", () => {
    const inventoryOf = (search: Config["storage"]) =>
      personalDataInventory({
        registry: quietRegistry,
        config: {
          storage: eu,
          readModels: { search },
          runtime: {
            personalData: {
              keyWrapper,
              tenantKeys: durableObjectTenantKeys({ storage: eu }),
              forgetLedger: { store: durableObjectForgetLedger({ storage: eu }) },
            },
          },
        },
      });
    expect(() => inventoryOf(memory())).toThrow(
      'readModels.search declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, or elsewhere under a safeguard, so give its memory() location: "eu"',
    );
    expect(() => inventoryOf(memory({ location: "us" }))).toThrow(ConfigurationError);
    expect(inventoryOf(memory({ location: "eu" })).records).toContainEqual({
      name: "tenant-keys",
      where: "tenant-keys",
      location: "eu",
      transfer: null,
      keptFor: null,
    });
  });

  it("refuses it wherever the configuration is resolved, the record of processing included", () => {
    expect(() =>
      personalDataInventory({
        registry: quietRegistry,
        config: {
          storage: eu,
          runtime: {
            personalData: { keyWrapper, tenantKeys: kvTenantKeys({ binding: "TENANT_KEYS" }) },
          },
        },
      }),
    ).toThrow(ConfigurationError);
  });

  it("holds no store to a jurisdiction when cloudflare() names none", () => {
    const keptIn = { location: "eu" } as const;
    expect(
      refusal({
        storage: cloudflare(),
        runtime: {
          personalData: {
            keyWrapper,
            tenantKeys: defineTenantKeyStore(() => {
              throw new Error("never opened");
            }, keptIn),
            forgetLedger: {
              store: defineForgetLedger(() => {
                throw new Error("never opened");
              }, keptIn),
            },
          },
        },
      }),
    ).toBe("resolved");
  });

  it("reads past personal data or a forget ledger that is null, as a Worker's code may hold", () => {
    for (const runtime of [
      { personalData: null },
      {
        personalData: { tenantKeys: durableObjectTenantKeys({ storage: eu }), forgetLedger: null },
      },
    ]) {
      expect(refusal({ storage: eu, runtime } as unknown as Config)).toBe("resolved");
    }
  });

  it("takes the keeper's stores, and stores of your own that name the jurisdiction", () => {
    const own = { location: "eu" } as const;
    for (const personalData of [
      {
        keyWrapper,
        tenantKeys: durableObjectTenantKeys({ storage: eu }),
        forgetLedger: { store: durableObjectForgetLedger({ storage: eu }) },
      },
      {
        keyWrapper,
        tenantKeys: defineTenantKeyStore(() => {
          throw new Error("never opened");
        }, own),
        forgetLedger: {
          store: defineForgetLedger(() => {
            throw new Error("never opened");
          }, own),
        },
      },
      {},
    ]) {
      expect(refusal({ storage: eu, runtime: { personalData } })).toBe("resolved");
    }
    // Without a jurisdiction, Workers KV is as good a place as any.
    expect(
      refusal({
        storage,
        runtime: {
          personalData: {
            keyWrapper,
            tenantKeys: kvTenantKeys({ binding: "TENANT_KEYS" }),
            forgetLedger: { store: kvForgetLedger({ binding: "FORGET_LEDGER" }) },
          },
        },
      }),
    ).toBe("resolved");
  });
});

const keptKeys = () => durableObjectTenantKeys({ storage, binding: "KEPT_KEEPER" }).create({ env });

describe("a Durable Object whose keys and ledger the keeper holds", () => {
  it("hands its tenant back with the entries of the ledger its keeper holds", async () => {
    const tenant = `${fresh()}handed-back`;
    const stub = env.KEPT_STORE.get(env.KEPT_STORE.idFromName(tenant));
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "bell" });
    await store.forget("ada");
    const frozen = await store.freezeTenant(tenant);
    expect(frozen).toEqual({ tenant, frozenAt: expect.any(String) });
    // The keeper's ledger takes no entry while the tenant is frozen, from the object or any other.
    const ledger = await durableObjectForgetLedger({ storage, binding: "KEPT_KEEPER" }).create({
      env,
      tenant,
    });
    expect(await ledger.fence.read()).toEqual({ state: "frozen", tenant, since: frozen.frozenAt });
    await expect(
      ledger.append([
        {
          personId: "bob",
          categories: null,
          eventId: "late",
          forgottenAt: frozen.frozenAt,
          reason: "requested",
        },
      ]),
    ).rejects.toMatchObject({ code: "TENANT_FROZEN", tenant, frozenAt: frozen.frozenAt });
    await expect(store.forget("bob")).rejects.toMatchObject({ code: "TENANT_FROZEN" });
    const parts: TenantExportPart[] = [];
    for await (const part of await store.exportTenant(tenant)) parts.push(part);
    const entries = parts.flatMap((part) =>
      part.kind === "forgetLedgerEntry" ? [part.entry] : [],
    );
    expect(entries).toEqual([
      expect.objectContaining({ personId: "ada", categories: null, reason: "requested" }),
    ]);
    expect(entries).toEqual(await ledger.read({ limit: 10 }));
    await store.unfreezeTenant(tenant);
    expect(await ledger.fence.read()).toEqual({ state: "open" });
  });

  it("forgets its tenant: the keeper keeps the forgetting, and the object serves nothing more", async () => {
    const tenant = `${fresh()}forgotten`;
    const stub = env.KEPT_STORE.get(env.KEPT_STORE.idFromName(tenant));
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 42, customer: "ada", note: "ring" });
    const forgotten = await store.forgetTenant(tenant);
    const keys = await (await keptKeys()).get(tenant);
    expect(keys).toMatchObject({
      keys: [],
      forgotten: { at: forgotten.forgottenAt, eventId: forgotten.eventId },
    });
    await expect(store.exportPersonalData("ada")).rejects.toMatchObject({
      code: "TENANT_FORGOTTEN",
    });
  });

  it("clears its ledger in the keeper once every recipient of its forgotten tenant is told", async () => {
    const tenant = `${fresh()}cleared-ledger`;
    const stub = env.KEPT_STORE.get(env.KEPT_STORE.idFromName(tenant));
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "bell" });
    await store.forget("ada");
    const ledger = await durableObjectForgetLedger({ storage, binding: "KEPT_KEEPER" }).create({
      env,
      tenant,
    });
    expect(await ledger.read({ limit: 10 })).toEqual([
      expect.objectContaining({ personId: "ada" }),
    ]);
    await store.forgetTenant(tenant);
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect(await ledger.read({ limit: 10 })).toEqual([]);
    expect(await ledger.readMark("restore:generation")).toEqual([]);
  });

  it("forgets again at the next start whoever was forgotten after its storage was copied", async () => {
    const tenant = `${fresh()}restored`;
    const stub = env.KEPT_STORE.get(env.KEPT_STORE.idFromName(tenant));
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "bell" });
    await store.commands.placeOrder({ orderId: "o-2", total: 9, customer: "bob", note: "door" });
    await runInDurableObject(stub, (instance) => instance.alarm());
    await runInDurableObject(stub, (_instance, state) => copyTables(state.storage, false));
    await store.forget("ada");
    await runInDurableObject(stub, (instance) => instance.alarm());
    await runInDurableObject(stub, (_instance, state) => copyTables(state.storage, true));
    clock.advance(FORGET_LEDGER_GRACE_MS);

    const outcome = await runInDurableObject(stub, async (_instance, state) => {
      const app = await createApp({
        registry: quietRegistry,
        config: configForObject(keptConfig, state.storage),
        env,
        tenant,
        clock,
      });
      try {
        return {
          forgotten: (await app.events.read({ limit: 100 }))
            .filter((event) => event.type === "PersonalDataForgotten")
            .map((event) => (event.payload as PersonalDataForgottenPayload).reason),
          ada: (await app.exportPersonalData("ada")).events[0]?.data,
          bob: (await app.exportPersonalData("bob")).events[0]?.data,
          lag: (await app.getLag()).forgetLedger,
        };
      } finally {
        await app.stop();
      }
    });
    expect(outcome).toMatchObject({
      forgotten: ["requested"],
      ada: { note: null },
      bob: { note: "door" },
      lag: { reconciled: true },
    });
  });

  it("is woken on the Worker's schedule while its tenant's key is under a previous master key", async () => {
    const tenant = `${fresh()}rewrap`;
    const stub = env.KEPT_STORE.get(env.KEPT_STORE.idFromName(tenant));
    await connect<typeof quietRegistry>(stub).commands.placeOrder({
      orderId: "o-1",
      total: 1,
      customer: "ada",
    });
    await runInDurableObject(stub, (_object, state) => state.storage.deleteAlarm());
    const keys = await keptKeys();
    const current = await keys.get(tenant);
    if (current === null) throw new Error("the tenant has no key");
    const { revision, ...held } = current;
    await keys.put(
      tenant,
      { ...held, keys: held.keys.map((version) => ({ ...version, wrappedBy: "previous" })) },
      revision,
    );
    const before = Date.now();
    await keptWorker.scheduled?.({} as ScheduledController, env, createExecutionContext());
    const armed = await runInDurableObject(stub, (_object, state) => state.storage.getAlarm());
    expect(armed).toBeGreaterThanOrEqual(before);
  });
});

// Workerd keeps no point-in-time history of an object's storage, so a backup is a copy of every
// table the app keeps, and restoring it puts their rows back.
const copyTables = (storage: DurableObjectStorage, restore: boolean): void => {
  const tables = storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bounda_%'",
    )
    .toArray()
    .map(({ name }) => name);
  for (const table of tables) {
    if (restore) {
      storage.sql.exec(`DELETE FROM "${table}"`);
      storage.sql.exec(`INSERT INTO "${table}" SELECT * FROM "backup_${table}"`);
    } else {
      storage.sql.exec(`CREATE TABLE "backup_${table}" AS SELECT * FROM "${table}"`);
    }
  }
};
