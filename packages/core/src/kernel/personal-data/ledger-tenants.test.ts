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
      unreached: [],
    });
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
      unreached: [],
    });
  });

  it("reaches the tenants the configuration names, whose stores nothing else lists", async () => {
    const ledgers = new Map([
      [DEFAULT_TENANT, await ledgerHolding()],
      ["acme", await ledgerHolding("acme")],
    ]);
    const config: ProjectConfig = ({ tenant }) => configOf(ledgers.get(tenant) ?? memory());
    expect(await listForgetLedgerTenants({ config })).toEqual({ tenants: [], unreached: [] });
    expect(await listForgetLedgerTenants({ config, tenants: ["acme"] })).toEqual({
      tenants: ["acme"],
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
    expect((await listForgetLedgerTenants({ config, tenants: ["b", "c"] })).tenants).toEqual([
      "acme",
    ]);
    expect(opened).toBe(1);

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
      unreached: [],
    });
  });
});
