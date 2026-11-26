import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import type { Config, ProjectConfig } from "../../config/types.ts";
import { memory } from "../../memory/index.ts";
import { defineForgetLedger, type ForgetLedgerSource } from "./forget-ledger.ts";
import { listForgetLedgerTenants } from "./ledger-tenants.ts";
import { defineTenantKeyStore, type TenantKeySource } from "./tenant-key-source.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

const START = new Date("2026-03-01T00:00:00.000Z");

const configOf = (
  store: ForgetLedgerSource,
  tenantKeys?: TenantKeySource,
  storage: Adapter = memory(),
): Config => ({
  storage,
  runtime: {
    personalData: {
      ...(tenantKeys === undefined ? {} : { tenantKeys }),
      forgetLedger: { store, keepFor: "30d" },
    },
  },
});

// A ledger adapter holding one entry of each tenant named.
const ledgerHolding = async (...tenants: readonly string[]): Promise<Adapter> => {
  const adapter = memory();
  for (const tenant of tenants) {
    const ledger = await adapter.createForgetLedger({ tenant });
    const entry: ForgetLedgerEntry = {
      personId: `${tenant}-p`,
      categories: null,
      eventId: `${tenant}-e`,
      forgottenAt: START.toISOString(),
      reason: "requested",
    };
    await ledger.append([entry]);
  }
  return adapter;
};

// A tenant key store that lists `tenants`, `limit` at a time, and records what it is asked.
const keysListing = (tenants: readonly string[], calls: string[] = []): TenantKeySource =>
  defineTenantKeyStore(
    (): TenantKeyStore => ({
      get: async () => null,
      put: async () => false,
      list: async ({ cursor, limit }) => {
        const from = cursor === null ? 0 : Number(cursor);
        calls.push(`list ${from}`);
        const next = from + limit;
        return {
          tenants: tenants.slice(from, next),
          cursor: next < tenants.length ? String(next) : null,
        };
      },
      close: async () => {
        calls.push("close");
      },
    }),
  );

describe("the tenants of a forget ledger's store", () => {
  it("lists every tenant whose entries the store holds, in code-unit order", async () => {
    const ledgerAdapter = await ledgerHolding("b", "a", "B");
    await ledgerAdapter.createForgetLedger({ tenant: "empty" });
    expect(await listForgetLedgerTenants({ config: configOf(ledgerAdapter) })).toEqual({
      tenants: ["B", "a", "b"],
      stores: [
        { store: ledgerAdapter, tenants: ["B", "a", "b"], named: ["B", "a", "b", DEFAULT_TENANT] },
      ],
      unreached: [],
    });
  });

  it("names each store's tenants in code-unit order, however its ledger lists them", async () => {
    const ledger = await memory().createForgetLedger({ tenant: DEFAULT_TENANT });
    const store = defineForgetLedger(() => ({ ...ledger, tenants: async () => ["b", "B", "a"] }));
    expect((await listForgetLedgerTenants({ config: configOf(store) })).stores).toEqual([
      { store, tenants: ["B", "a", "b"], named: ["B", "a", "b", DEFAULT_TENANT] },
    ]);
  });

  it("names, of each store, the tenants whose configuration names it: definitions made anew for each tenant are one store when their ledgers give one storeId", async () => {
    const shared = await ledgerHolding("a", "b");
    // A function of the tenant, which defines the store anew whenever it is called.
    const config: ProjectConfig = () =>
      configOf(
        defineForgetLedger(({ tenant: asked }) => shared.createForgetLedger({ tenant: asked })),
      );
    const { stores } = await listForgetLedgerTenants({ config });
    expect(stores.map(({ tenants, named }) => ({ tenants, named }))).toEqual([
      { tenants: ["a", "b"], named: ["a", "b", DEFAULT_TENANT] },
    ]);

    // A ledger of your own that gives none is one store per definition.
    const unnamed: ProjectConfig = () =>
      configOf(
        defineForgetLedger(async ({ tenant: asked }) => {
          const { storeId: _, ...own } = await shared.createForgetLedger({ tenant: asked });
          return own;
        }),
      );
    const apart = await listForgetLedgerTenants({ config: unnamed });
    expect(apart.stores.map(({ tenants, named }) => ({ tenants, named }))).toEqual([
      { tenants: ["a", "b"], named: [DEFAULT_TENANT] },
      { tenants: ["a", "b"], named: ["a"] },
      { tenants: ["a", "b"], named: ["b"] },
    ]);
  });

  it("reads apart the stores one definition opens for each tenant, as their ledgers tell", async () => {
    const files = new Map<string, Awaited<ReturnType<typeof ledgerHolding>>>([
      [DEFAULT_TENANT, await ledgerHolding(DEFAULT_TENANT, "a")],
      ["a", await ledgerHolding("a", "b")],
      ["b", await ledgerHolding("b")],
    ]);
    // One definition, a store of each tenant's own inside it.
    const definition = defineForgetLedger(({ tenant: asked }) =>
      (files.get(asked) ?? memory()).createForgetLedger({ tenant: asked }),
    );
    const { tenants, stores } = await listForgetLedgerTenants({
      config: () => configOf(definition),
    });
    expect(tenants).toEqual(["a", "b", DEFAULT_TENANT]);
    expect(stores.map(({ tenants: held, named }) => ({ held, named }))).toEqual([
      { held: ["a", DEFAULT_TENANT], named: [DEFAULT_TENANT] },
      { held: ["a", "b"], named: ["a"] },
      { held: ["b"], named: ["b"] },
    ]);
  });

  it("names no tenant whose configuration has no forget ledger as naming a store", async () => {
    const holding = await ledgerHolding("none");
    const config: ProjectConfig = ({ tenant }) =>
      tenant === "none" ? { storage: memory() } : configOf(holding);
    expect((await listForgetLedgerTenants({ config })).stores).toEqual([
      { store: holding, tenants: ["none"], named: [DEFAULT_TENANT] },
    ]);
  });

  it("refuses a ledger of your own that cannot list them", async () => {
    const { tenants: _, ...unlisted } = await memory().createForgetLedger({
      tenant: DEFAULT_TENANT,
    });
    await expect(
      listForgetLedgerTenants({ config: configOf(defineForgetLedger(() => unlisted)) }),
    ).rejects.toThrow(/cannot list its tenants/);
  });

  it("rejects when the starting tenant's tenant key store cannot be listed", async () => {
    const failing = defineTenantKeyStore(() => {
      throw new Error("the tenant key store is down");
    });
    await expect(
      listForgetLedgerTenants({ config: configOf(await ledgerHolding("a"), failing) }),
    ).rejects.toThrow("the tenant key store is down");
  });
});

describe("the tenants of every forget ledger's store the configuration names", () => {
  it("reaches the ledger of every tenant its tenant key store lists, a page at a time", async () => {
    const ledgers = new Map([
      [DEFAULT_TENANT, await ledgerHolding()],
      ["acme", await ledgerHolding("acme")],
      ["globex", await ledgerHolding("globex", "stray")],
      ["initech", await ledgerHolding()],
    ]);
    const calls: string[] = [];
    const tenantKeys = keysListing(["acme", "globex", "initech"], calls);
    const config: ProjectConfig = ({ tenant }) =>
      configOf(ledgers.get(tenant) ?? memory(), tenantKeys);
    expect(await listForgetLedgerTenants({ config })).toEqual({
      tenants: ["acme", "globex", "stray"],
      stores: [
        { store: ledgers.get("acme"), tenants: ["acme"], named: ["acme"] },
        { store: ledgers.get("globex"), tenants: ["globex", "stray"], named: ["globex"] },
      ],
      unreached: [],
    });
    // One store, read once, whichever tenants name it.
    expect(calls.filter((call) => call.startsWith("list"))).toEqual(["list 0"]);
  });

  it("reads every page of a tenant key store", async () => {
    const tenants = Array.from({ length: 1_001 }, (_, index) => `t-${index}`);
    const calls: string[] = [];
    const last = await ledgerHolding("t-1000");
    const tenantKeys = keysListing(tenants, calls);
    const config: ProjectConfig = ({ tenant }) =>
      configOf(tenant === "t-1000" ? last : memory(), tenantKeys);
    expect((await listForgetLedgerTenants({ config })).tenants).toEqual(["t-1000"]);
    expect(calls.filter((call) => call.startsWith("list"))).toEqual([
      "list 0",
      "list 500",
      "list 1000",
    ]);
    expect(calls.filter((call) => call === "close")).toHaveLength(1);
  });

  it("reaches the tenants a store lists, and what their own stores list", async () => {
    const ledgers = new Map([
      [DEFAULT_TENANT, await ledgerHolding("acme")],
      ["acme", await ledgerHolding("acme", "globex")],
      ["globex", await ledgerHolding("initech")],
    ]);
    const config: ProjectConfig = ({ tenant }) => configOf(ledgers.get(tenant) ?? memory());
    expect(await listForgetLedgerTenants({ config })).toEqual({
      tenants: ["acme", "globex", "initech"],
      stores: [
        { store: ledgers.get(DEFAULT_TENANT), tenants: ["acme"], named: [DEFAULT_TENANT] },
        { store: ledgers.get("acme"), tenants: ["acme", "globex"], named: ["acme"] },
        { store: ledgers.get("globex"), tenants: ["initech"], named: ["globex"] },
      ],
      unreached: [],
    });
  });

  it("reaches the tenants the configuration names, whose stores nothing else lists", async () => {
    const ledgers = new Map([
      [DEFAULT_TENANT, await ledgerHolding()],
      ["acme", await ledgerHolding("acme")],
    ]);
    const config: ProjectConfig = ({ tenant }) => configOf(ledgers.get(tenant) ?? memory());
    expect(await listForgetLedgerTenants({ config })).toEqual({
      tenants: [],
      stores: [],
      unreached: [],
    });
    expect(await listForgetLedgerTenants({ config, tenants: ["acme"] })).toEqual({
      tenants: ["acme"],
      stores: [{ store: ledgers.get("acme"), tenants: ["acme"], named: ["acme"] }],
      unreached: [],
    });
  });

  it("starts from the tenant named", async () => {
    const ledgers = new Map([
      [DEFAULT_TENANT, await ledgerHolding()],
      ["acme", await ledgerHolding("acme")],
    ]);
    const config: ProjectConfig = ({ tenant }) => configOf(ledgers.get(tenant) ?? memory());
    expect((await listForgetLedgerTenants({ config, tenant: "acme" })).tenants).toEqual(["acme"]);
  });

  it("reads once a store several tenants name, by its definition or as the same database", async () => {
    let opened = 0;
    const shared = await memory().createForgetLedger({ tenant: "acme" });
    await shared.append([
      {
        personId: "p",
        categories: null,
        eventId: "e",
        forgottenAt: START.toISOString(),
        reason: "requested",
      },
    ]);
    const definition = defineForgetLedger(() => {
      opened += 1;
      return shared;
    });
    const config: ProjectConfig = () => configOf(definition);
    let listed = 0;
    const counted = {
      ...shared,
      tenants: async () => {
        listed += 1;
        return shared.tenants?.() ?? [];
      },
    };
    const counting = defineForgetLedger(() => {
      opened += 1;
      return counted;
    });
    expect((await listForgetLedgerTenants({ config, tenants: ["b", "c"] })).tenants).toEqual([
      "acme",
    ]);
    // Opened for each tenant reached, to tell which store it is.
    expect(opened).toBe(4);
    await listForgetLedgerTenants({ config: () => configOf(counting), tenants: ["b", "c"] });
    expect(listed).toBe(1);

    // Two adapters of one kind with the same options are one database.
    const seen: string[] = [];
    const sqlite = (): Adapter => {
      const { adapter } = createNodeSqliteAdapter(":memory:");
      return {
        ...adapter,
        createForgetLedger: async (args) => {
          seen.push(args.tenant);
          return adapter.createForgetLedger(args);
        },
      };
    };
    await listForgetLedgerTenants({ config: () => configOf(sqlite()), tenants: ["b"] });
    expect(seen).toEqual([DEFAULT_TENANT]);
  });

  it("goes on past a tenant whose configuration or stores cannot be read, and names it", async () => {
    const down = new Error("the ledger is down");
    const broken = new Error("no configuration for broken");
    const ledgers = new Map<string, ForgetLedgerSource>([
      [DEFAULT_TENANT, await ledgerHolding("a")],
      ["a", await ledgerHolding("a", "b")],
      [
        "down",
        defineForgetLedger(
          async (): Promise<ForgetLedger> => ({
            ...(await memory().createForgetLedger({ tenant: "down" })),
            tenants: async () => {
              throw down;
            },
          }),
        ),
      ],
      [
        "unlisted",
        defineForgetLedger(async () => {
          const { tenants: _, ...unlisted } = await memory().createForgetLedger({
            tenant: "unlisted",
          });
          return unlisted;
        }),
      ],
    ]);
    const config: ProjectConfig = ({ tenant }) => {
      if (tenant === "broken") throw broken;
      return configOf(ledgers.get(tenant) ?? memory());
    };
    const listed = await listForgetLedgerTenants({
      config,
      tenants: ["broken", "down", "unlisted"],
    });
    expect(listed.tenants).toEqual(["a", "b"]);
    expect(listed.unreached.map(({ tenant }) => tenant)).toEqual(["broken", "down", "unlisted"]);
    expect(listed.unreached[0]?.error).toBe(broken);
    expect(listed.unreached[1]?.error).toBe(down);
    expect(String(listed.unreached[2]?.error)).toMatch(/cannot list its tenants/);
  });

  it("passes over a tenant without a ledger, or with one that expires its entries on its own", async () => {
    const {
      prune: _,
      tenants: __,
      ...expiring
    } = await memory().createForgetLedger({
      tenant: "kv",
    });
    const config: ProjectConfig = ({ tenant }) =>
      tenant === "none"
        ? { storage: memory() }
        : tenant === "kv"
          ? configOf(defineForgetLedger(() => expiring))
          : configOf(memory());
    expect(await listForgetLedgerTenants({ config, tenants: ["none", "kv"] })).toEqual({
      tenants: [],
      stores: [],
      unreached: [],
    });
  });

  it("resolves each tenant's configuration once, the starting one's too, and no other", async () => {
    const called: string[] = [];
    const ledgers = new Map([
      [DEFAULT_TENANT, await ledgerHolding(DEFAULT_TENANT, "zeta")],
      ["zeta", await ledgerHolding("alpha", DEFAULT_TENANT)],
    ]);
    const config: ProjectConfig = ({ tenant }) => {
      called.push(tenant);
      return configOf(ledgers.get(tenant) ?? memory());
    };
    expect(await listForgetLedgerTenants({ config, tenants: ["zeta"] })).toEqual({
      tenants: ["alpha", DEFAULT_TENANT, "zeta"],
      stores: [
        {
          store: ledgers.get(DEFAULT_TENANT),
          tenants: [DEFAULT_TENANT, "zeta"],
          named: [DEFAULT_TENANT],
        },
        { store: ledgers.get("zeta"), tenants: ["alpha", DEFAULT_TENANT], named: ["zeta"] },
      ],
      unreached: [],
    });
    expect(called).toEqual([DEFAULT_TENANT, "zeta", "alpha"]);
    called.length = 0;
    expect((await listForgetLedgerTenants({ config })).tenants).toEqual([
      "alpha",
      DEFAULT_TENANT,
      "zeta",
    ]);
    expect(called).toEqual([DEFAULT_TENANT, "zeta", "alpha"]);
  });

  it("names once a tenant it cannot read, however many stores list it", async () => {
    const broken = new Error("no configuration for broken");
    const listing = await ledgerHolding("broken");
    const config: ProjectConfig = ({ tenant }) => {
      if (tenant === "broken") throw broken;
      return configOf(listing);
    };
    expect(await listForgetLedgerTenants({ config, tenants: ["broken"] })).toEqual({
      tenants: ["broken"],
      stores: [{ store: listing, tenants: ["broken"], named: [DEFAULT_TENANT] }],
      unreached: [{ tenant: "broken", error: broken }],
    });
  });

  it("opens the store a definition gives each reached tenant, with the tenant's keepFor", async () => {
    const opened: { readonly tenant: string; readonly keepForMs: number | undefined }[] = [];
    const shared = defineForgetLedger(async ({ tenant, keepForMs }) => {
      opened.push({ tenant, keepForMs });
      return memory().createForgetLedger({ tenant });
    });
    const config: ProjectConfig = ({ tenant }) =>
      tenant === DEFAULT_TENANT ? configOf(memory()) : configOf(shared);
    await listForgetLedgerTenants({ config, tenants: ["b", "c"] });
    const keepForMs = 30 * 24 * 60 * 60_000;
    expect(opened).toEqual([
      { tenant: "b", keepForMs },
      { tenant: "c", keepForMs },
    ]);
  });

  it("reads two databases of one kind apart, and a storage without a tenant key store", async () => {
    const seen: string[] = [];
    const sqliteAt = (path: string): Adapter => {
      const { adapter } = createNodeSqliteAdapter(":memory:");
      return {
        ...adapter,
        options: { path },
        createForgetLedger: async (args) => {
          seen.push(`${path} ${args.tenant}`);
          return adapter.createForgetLedger(args);
        },
      };
    };
    // A storage that brings no tenant key store of its own, as memory() does.
    const { ephemeralKeys: _, ...storage } = memory();
    const config: ProjectConfig = ({ tenant }) =>
      configOf(sqliteAt(tenant === DEFAULT_TENANT ? "a.db" : "b.db"), undefined, storage);
    expect(await listForgetLedgerTenants({ config, tenants: ["b"] })).toEqual({
      tenants: [],
      stores: [],
      unreached: [],
    });
    expect(seen).toEqual([`a.db ${DEFAULT_TENANT}`, "b.db b"]);
  });

  it("reads a database that holds both a forget ledger and tenant keys as both", async () => {
    const both = join(mkdtempSync(join(tmpdir(), "bounda-ledger-tenants-")), "both.db");
    const bothAdapter = (): Adapter => createNodeSqliteAdapter(both).adapter;
    const keys = await bothAdapter().createTenantKeyStore();
    await keys.put("acme", { store: "s-1", keys: [], forgotten: null }, null);
    await keys.close?.();
    const ledger = await bothAdapter().createForgetLedger({ tenant: "zeta" });
    await ledger.append([
      {
        personId: "p",
        categories: null,
        eventId: "e",
        forgottenAt: START.toISOString(),
        reason: "requested",
      },
    ]);
    await ledger.close?.();
    // Only acme's configuration names that database's ledger, and only its keys list acme.
    const config: ProjectConfig = ({ tenant }) =>
      tenant === "acme"
        ? configOf(bothAdapter(), bothAdapter())
        : configOf(memory(), bothAdapter());
    expect(await listForgetLedgerTenants({ config })).toEqual({
      tenants: ["zeta"],
      // An adapter of the same kind with the same options: one store, which acme names.
      stores: [expect.objectContaining({ tenants: ["zeta"], named: ["acme"] })],
      unreached: [],
    });
  });

  it("tells an adapter whose options JSON cannot write by itself", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const seen: string[] = [];
    const odd = (): Adapter => {
      const { adapter } = createNodeSqliteAdapter(":memory:");
      return {
        ...adapter,
        options: circular,
        createForgetLedger: async (args) => {
          seen.push(args.tenant);
          return adapter.createForgetLedger(args);
        },
      };
    };
    const config: ProjectConfig = () => configOf(odd());
    expect(await listForgetLedgerTenants({ config, tenants: ["b"] })).toEqual({
      tenants: [],
      stores: [],
      unreached: [],
    });
    expect(seen).toEqual([DEFAULT_TENANT, "b"]);
  });
});
