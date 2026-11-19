import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ConfigurationError,
  createApp,
  FORGET_LEDGER_GRACE_MS,
  type PersonalDataForgottenPayload,
  personalDataInventory,
} from "@bounda-dev/core";
import type { TenantKeyRecord, TenantKeyStore } from "@bounda-dev/core/adapter";
import { forgetLedgerContract, tenantKeyStoreContract } from "@bounda-dev/core/adapter/testing";
import {
  type Config,
  defineForgetLedger,
  defineTenantKeyStore,
  masterKey,
} from "@bounda-dev/core/config";
import { describe, expect, it } from "vitest";
import { configForObject } from "../src/bounda-object.ts";
import { connect } from "../src/client.ts";
import { cloudflare, cloudflareStorageOf } from "../src/definition.ts";
import { kvForgetLedger } from "../src/forget-ledger.ts";
import {
  DEFAULT_KEEPER_BINDING,
  durableObjectForgetLedger,
  durableObjectTenantKeys,
} from "../src/keeper-stores.ts";
import { kvTenantKeys } from "../src/tenant-keys.ts";
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
    expect(durableObjectTenantKeys({ storage: eu }).location).toBe("jurisdiction eu");
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
    expect(durableObjectForgetLedger({ storage: eu }).location).toBe("jurisdiction eu");
    expect(durableObjectForgetLedger({ storage }).location).toBeUndefined();
  });

  it("refuses an app that names no tenant, whose entries no keeper would hold", async () => {
    await expect(
      Promise.resolve().then(() => durableObjectForgetLedger({ storage }).create({ env })),
    ).rejects.toThrow(
      new ConfigurationError(
        "A keeper forget ledger keeps each tenant's entries in the tenant's own keeper, and this app names no tenant: run it in a Bounda Durable Object, or give createApp a tenant",
      ),
    );
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
    const odd = Object.assign(Object.create(env) as object, {
      NOTHING: null,
      HALF: { idFromName: () => undefined },
    }) as Cloudflare.Env;
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
    expect(await other.raiseLedgerMark(tenant, "m", 1)).toEqual(mismatched);
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
    expect(await own.raiseLedgerMark(tenant, "m", 3)).toEqual({ ok: true, value: null });
    expect(await own.readLedgerMark(tenant, "m")).toEqual({ ok: true, value: 3 });
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
          "This keeper Durable Object was created in no jurisdiction, and cloudflare() names jurisdiction eu: the keys and ledger entries it holds never leave where it was created. Reach it through durableObjectTenantKeys() and durableObjectForgetLedger() alone",
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
  const keyWrapper = masterKey({ from: "BOUNDA_MASTER_KEY" });
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
      'runtime.personalData.tenantKeys keeps what it holds where it names no jurisdiction, as Workers KV does, and cloudflare() keeps the tenants\' objects in jurisdiction eu: use durableObjectTenantKeys({ storage }), which keeps it in the same jurisdiction, or a store of your own that names it, through defineTenantKeyStore(create, { location: "jurisdiction eu" })',
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
      'runtime.personalData.forgetLedger.store keeps what it holds where it names no jurisdiction, as Workers KV does, and cloudflare() keeps the tenants\' objects in jurisdiction eu: use durableObjectForgetLedger({ storage }), which keeps it in the same jurisdiction, or a store of your own that names it, through defineForgetLedger(create, { location: "jurisdiction eu" })',
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
      'runtime.personalData.tenantKeys keeps what it holds in jurisdiction fedramp, and cloudflare() keeps the tenants\' objects in jurisdiction eu: use durableObjectTenantKeys({ storage }), which keeps it in the same jurisdiction, or a store of your own that names it, through defineTenantKeyStore(create, { location: "jurisdiction eu" })',
    );
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
    const own = { location: "jurisdiction eu" };
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
