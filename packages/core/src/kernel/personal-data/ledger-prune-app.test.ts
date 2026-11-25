import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { Config } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { DurationInput } from "../../contracts/duration.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createApp } from "../app.ts";
import { defineForgetLedger, type ForgetLedgerSource } from "./forget-ledger.ts";
import { listForgetLedgerTenants, pruneTenantForgetLedger } from "./ledger-prune.ts";
import { masterKey } from "./master-key.ts";
import { defineTenantKeyStore } from "./tenant-key-source.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

const DAY = 24 * 60 * 60_000;
const START = new Date("2026-03-01T00:00:00.000Z");
const KEEP_FOR_MS = 30 * DAY;
const LATER = new Date(START.getTime() + KEEP_FOR_MS + 2 * DAY);

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), name: notPersonal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ name: command.payload.name })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const configOf = (
  storage: Adapter,
  store: ForgetLedgerSource,
  keepFor?: DurationInput,
): Config => ({
  storage,
  runtime: {
    personalData: {
      forgetLedger: keepFor === undefined ? { store } : { store, keepFor },
    },
  },
});

let starts = 0;

const start = async (config: Config) => {
  starts += 1;
  const app = await createApp({
    registry,
    config,
    ids: createSequentialIdGenerator({ prefix: `app-${starts}` }),
    clock: createFixedClock(START),
  });
  stops.push(() => app.stop());
  return app;
};

const entry = (personId: string, eventId: string, at: Date): ForgetLedgerEntry => ({
  personId,
  categories: null,
  eventId,
  forgottenAt: at.toISOString(),
  reason: "requested",
});

const entriesOf = async (ledger: ForgetLedger): Promise<readonly string[]> =>
  (await ledger.read({ limit: 100 })).map(({ personId }) => personId);

describe("pruning a tenant's forget ledger with no app running", () => {
  it("keeps what the database has yet to apply until an app of the tenant applies it, then removes it", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const config = configOf(storage, ledgerAdapter, "30d");
    const first = await start(config);
    const commands = first.commands as unknown as Record<
      string,
      (payload: { customerId: string; name: string }) => Promise<unknown>
    >;
    await commands.registerCustomer?.({ customerId: "ana", name: "Ana" });
    await first.forget("ana");
    await first.runUntilIdle();
    await first.stop();
    const ledger = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
    // A forgetting the database lost, as a copy restored while the app was stopped did.
    await ledger.append([entry("cy", "lost-cy", new Date(START.getTime() - DAY))]);

    expect(await pruneTenantForgetLedger({ config, now: LATER })).toEqual({
      tenant: DEFAULT_TENANT,
      before: new Date(START.getTime() - DAY).toISOString(),
      unapplied: true,
    });
    expect(await entriesOf(ledger)).toEqual(["cy", "ana"]);

    await start(config).then((app) => app.stop());
    expect(await pruneTenantForgetLedger({ config, now: LATER })).toEqual({
      tenant: DEFAULT_TENANT,
      before: new Date(LATER.getTime() - KEEP_FOR_MS).toISOString(),
      unapplied: false,
    });
    expect(await entriesOf(ledger)).toEqual([]);
  });

  it("prunes past keepFor, without opening its database, a tenant forgotten while its ledger did not answer", async () => {
    const base = memory();
    let opened = 0;
    const storage: Adapter = {
      ...base,
      createStorage: async () => {
        opened += 1;
        return base.createStorage();
      },
    };
    const ledgerAdapter = memory();
    const inner = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
    const config = configOf(
      storage,
      defineForgetLedger(() => ({
        ...inner,
        fence: {
          read: inner.fence.read,
          set: async () => {
            throw new Error("the ledger is down");
          },
        },
      })),
      "30d",
    );
    const app = await start(config);
    await app.forgetTenant(DEFAULT_TENANT);
    await app.stop();
    expect((await inner.fence.read()).state).toBe("open");
    await inner.append([entry("ana", "e-ana", new Date(START.getTime() - DAY))]);
    opened = 0;
    expect(await pruneTenantForgetLedger({ config, now: LATER })).toEqual({
      tenant: DEFAULT_TENANT,
      before: new Date(LATER.getTime() - KEEP_FOR_MS).toISOString(),
      unapplied: false,
    });
    expect(opened).toBe(0);
    expect(await entriesOf(inner)).toEqual([]);
  });

  it("asks the tenant key store whether the tenant was forgotten, and closes it", async () => {
    const closed: string[] = [];
    const store = createMemoryTenantKeyStore();
    const ledgerAdapter = memory();
    const ledger = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
    await ledger.append([entry("ana", "e-ana", START)]);
    const config: Config = {
      storage: memory(),
      runtime: {
        personalData: {
          keyWrapper: masterKey({ from: "PRUNE_KEY" }),
          tenantKeys: defineTenantKeyStore(() => ({
            ...store,
            close: async () => {
              closed.push("tenant keys");
            },
          })),
          forgetLedger: { store: ledgerAdapter, keepFor: "30d" },
        },
      },
    };
    const env = { PRUNE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) };
    expect(await pruneTenantForgetLedger({ config, env, now: LATER })).toMatchObject({
      unapplied: true,
    });
    expect(closed).toEqual(["tenant keys"]);
  });

  it("keeps what a database without keys has not applied, with no tenant key store to ask", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bounda-prune-"));
    try {
      const { adapter, db } = createNodeSqliteAdapter(join(directory, "store.db"));
      const ledgerAdapter = memory();
      const ledger = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      await ledger.append([entry("ana", "e-ana", START)]);
      expect(
        await pruneTenantForgetLedger({
          config: configOf(adapter, ledgerAdapter, "30d"),
          now: LATER,
        }),
      ).toEqual({ tenant: DEFAULT_TENANT, before: START.toISOString(), unapplied: true });
      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prunes the tenant named, and leaves the others' entries", async () => {
    const ledgerAdapter = memory();
    const old = new Date(START.getTime() - DAY);
    for (const tenant of ["acme", "globex"]) {
      const ledger = await ledgerAdapter.createForgetLedger({ tenant });
      await ledger.append([entry(`${tenant}-p`, `${tenant}-e`, old)]);
      // Forgotten, so its database is never opened.
      await ledger.fence.set({ state: "forgotten", tenant, since: old.toISOString() });
    }
    const config = configOf(memory(), ledgerAdapter, "30d");
    expect(await pruneTenantForgetLedger({ config, tenant: "acme", now: LATER })).toMatchObject({
      tenant: "acme",
      unapplied: false,
    });
    expect(await entriesOf(await ledgerAdapter.createForgetLedger({ tenant: "acme" }))).toEqual([]);
    expect(await entriesOf(await ledgerAdapter.createForgetLedger({ tenant: "globex" }))).toEqual([
      "globex-p",
    ]);
  });

  it("leaves a database without Bounda's tables as it is, and keeps every entry", async () => {
    const { adapter } = createNodeSqliteAdapter(":memory:");
    const ledgerAdapter = memory();
    const ledger = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
    await ledger.append([entry("ana", "e-ana", START)]);
    expect(
      await pruneTenantForgetLedger({
        config: configOf(adapter, ledgerAdapter, "30d"),
        now: LATER,
      }),
    ).toEqual({ tenant: DEFAULT_TENANT, before: START.toISOString(), unapplied: true });
    expect(await entriesOf(ledger)).toEqual(["ana"]);
    expect((await adapter.schemaVersions()).find(({ scope }) => scope === "storage")?.version).toBe(
      0,
    );
  });

  it("refuses without a forget ledger, without keepFor, or with one that expires its entries on its own", async () => {
    const { prune: _, ...expiring } = await memory().createForgetLedger({ tenant: DEFAULT_TENANT });
    const closed: string[] = [];
    const cases: readonly [Config, RegExp][] = [
      [{ storage: memory() }, /needs runtime\.personalData\.forgetLedger$/],
      [configOf(memory(), memory()), /needs runtime\.personalData\.forgetLedger\.keepFor/],
      [
        configOf(
          memory(),
          defineForgetLedger(() => ({
            ...expiring,
            close: async () => {
              closed.push("expiring");
            },
          })),
          "30d",
        ),
        /expires its entries on its own/,
      ],
      // One that holds nothing open.
      [
        configOf(
          memory(),
          defineForgetLedger(() => expiring),
          "30d",
        ),
        /expires its entries on its own/,
      ],
    ];
    for (const [config, message] of cases) {
      await expect(pruneTenantForgetLedger({ config })).rejects.toThrow(message);
      await expect(listForgetLedgerTenants({ config })).rejects.toThrow(message);
      await expect(pruneTenantForgetLedger({ config })).rejects.toBeInstanceOf(ConfigurationError);
    }
    expect(closed).toEqual(["expiring", "expiring", "expiring"]);
  });

  it("closes the database it opened and the ledger, once pruned", async () => {
    const closed: string[] = [];
    const base = memory();
    const storage: Adapter = {
      ...base,
      createStorage: async () => {
        const opened = await base.createStorage();
        return {
          ...opened,
          close: async () => {
            closed.push("storage");
            await opened.close();
          },
        };
      },
    };
    const ledger = await memory().createForgetLedger({ tenant: DEFAULT_TENANT });
    await ledger.append([entry("ana", "e-ana", START)]);
    const config = configOf(
      storage,
      defineForgetLedger(() => ({
        ...ledger,
        close: async () => {
          closed.push("ledger");
        },
      })),
      "30d",
    );
    expect(await pruneTenantForgetLedger({ config, now: LATER })).toMatchObject({
      unapplied: true,
    });
    expect(closed).toEqual(["storage", "ledger"]);
    expect(await listForgetLedgerTenants({ config })).toEqual([DEFAULT_TENANT]);
    expect(closed).toEqual(["storage", "ledger", "ledger"]);
  });
});

describe("pruning beside a storage only its host opens", () => {
  it("refuses, and closes the ledger", async () => {
    const closed: string[] = [];
    const ledger = await memory().createForgetLedger({ tenant: DEFAULT_TENANT });
    const config: Config = {
      storage: { kind: "bounda-adapter", name: "host-only", options: {} } as unknown as Adapter,
      runtime: {
        personalData: {
          forgetLedger: {
            store: defineForgetLedger(() => ({
              ...ledger,
              close: async () => {
                closed.push("ledger");
              },
            })),
            keepFor: "30d",
          },
        },
      },
    };
    await expect(pruneTenantForgetLedger({ config })).rejects.toThrow(/opened only by its host/);
    expect(closed).toEqual(["ledger"]);
  });
});

describe("the tenants of a forget ledger's store", () => {
  it("lists every tenant whose entries the store holds, in code-unit order", async () => {
    const ledgerAdapter = memory();
    for (const tenant of ["b", "a", "B"]) {
      const ledger = await ledgerAdapter.createForgetLedger({ tenant });
      await ledger.append([entry(`${tenant}-p`, `${tenant}-e`, START)]);
    }
    await ledgerAdapter.createForgetLedger({ tenant: "empty" });
    expect(
      await listForgetLedgerTenants({ config: configOf(memory(), ledgerAdapter, "30d") }),
    ).toEqual(["B", "a", "b"]);
  });

  it("refuses a ledger of your own that cannot list them", async () => {
    const { tenants: _, ...unlisted } = await memory().createForgetLedger({
      tenant: DEFAULT_TENANT,
    });
    await expect(
      listForgetLedgerTenants({
        config: configOf(
          memory(),
          defineForgetLedger(() => unlisted),
          "30d",
        ),
      }),
    ).rejects.toThrow(/cannot list its tenants/);
  });
});
