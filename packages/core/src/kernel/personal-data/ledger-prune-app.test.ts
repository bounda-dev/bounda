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
import { pruneTenantForgetLedger } from "./ledger-prune.ts";
import { listForgetLedgerTenants } from "./ledger-tenants.ts";
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

    expect(await pruneTenantForgetLedger({ registry, config, now: LATER })).toEqual({
      tenant: DEFAULT_TENANT,
      before: new Date(START.getTime() - DAY).toISOString(),
      unapplied: true,
      named: true,
      stranded: false,
    });
    expect(await entriesOf(ledger)).toEqual(["cy", "ana"]);

    await start(config).then((app) => app.stop());
    expect(await pruneTenantForgetLedger({ registry, config, now: LATER })).toEqual({
      tenant: DEFAULT_TENANT,
      before: new Date(LATER.getTime() - KEEP_FOR_MS).toISOString(),
      unapplied: false,
      named: true,
      stranded: false,
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
    expect(await pruneTenantForgetLedger({ registry, config, now: LATER })).toEqual({
      tenant: DEFAULT_TENANT,
      before: new Date(LATER.getTime() - KEEP_FOR_MS).toISOString(),
      unapplied: false,
      named: true,
      stranded: false,
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
    expect(await pruneTenantForgetLedger({ registry, config, env, now: LATER })).toMatchObject({
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
          registry,
          config: configOf(adapter, ledgerAdapter, "30d"),
          now: LATER,
        }),
      ).toEqual({
        tenant: DEFAULT_TENANT,
        before: START.toISOString(),
        unapplied: true,
        named: true,
        stranded: false,
      });
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
    expect(
      await pruneTenantForgetLedger({ registry, config, tenant: "acme", now: LATER }),
    ).toMatchObject({
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
        registry,
        config: configOf(adapter, ledgerAdapter, "30d"),
        now: LATER,
      }),
    ).toEqual({
      tenant: DEFAULT_TENANT,
      before: START.toISOString(),
      unapplied: true,
      named: true,
      stranded: false,
    });
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
      await expect(pruneTenantForgetLedger({ registry, config })).rejects.toThrow(message);
      await expect(listForgetLedgerTenants({ config })).rejects.toThrow(message);
      await expect(pruneTenantForgetLedger({ registry, config })).rejects.toBeInstanceOf(
        ConfigurationError,
      );
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
    expect(await pruneTenantForgetLedger({ registry, config, now: LATER })).toMatchObject({
      unapplied: true,
    });
    expect(closed).toEqual(["storage", "ledger"]);
    expect(await listForgetLedgerTenants({ config })).toEqual({
      tenants: [DEFAULT_TENANT],
      stores: [
        {
          store: config.runtime?.personalData?.forgetLedger?.store,
          tenants: [DEFAULT_TENANT],
          named: [DEFAULT_TENANT],
        },
      ],
      unreached: [],
    });
    expect(closed).toEqual(["storage", "ledger", "ledger"]);
  });
});

type Commands = Record<string, (payload: { customerId: string; name: string }) => Promise<unknown>>;

const register = async (app: Awaited<ReturnType<typeof start>>, ...persons: string[]) => {
  for (const person of persons) {
    await (app.commands as unknown as Commands).registerCustomer?.({
      customerId: person,
      name: person,
    });
  }
  await app.runUntilIdle();
};

const intention = (
  personId: string,
  eventId: string,
  at: Date,
  extra: Partial<ForgetLedgerEntry> = {},
): ForgetLedgerEntry => ({ ...entry(personId, eventId, at), committed: false, ...extra });

describe("pruning, with the app's registry, the intentions only the app decides", () => {
  it("removes a redaction's intention once it would make no field unreadable, and keeps it while it would", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const config = configOf(storage, ledgerAdapter, "30d");
    const app = await start(config);
    await register(app, "ana");
    const [registered] = await app.events.read({ limit: 1 });
    if (registered === undefined) throw new Error("ana registered");
    const target = {
      id: registered.id,
      aggregateType: "customer",
      aggregateId: "ana",
      type: "CustomerRegistered",
      fields: ["name"],
    };
    const ledger = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
    // A redaction whose commit never happened, and that would still seal ana's name.
    await ledger.append([
      intention("ana", "redaction-ana", START, { redaction: { events: [target] } }),
    ]);
    expect(await pruneTenantForgetLedger({ registry, config, now: LATER })).toMatchObject({
      before: START.toISOString(),
      unapplied: true,
    });

    // Redacted since, the name reads as redacted: nothing is left for the intention to seal.
    await app.redact("ana", { events: [target] } as never);
    await app.runUntilIdle();
    await app.stop();
    expect(await pruneTenantForgetLedger({ registry, config, now: LATER })).toMatchObject({
      before: new Date(LATER.getTime() - KEEP_FOR_MS).toISOString(),
      unapplied: false,
    });
    expect(await entriesOf(ledger)).toEqual([]);
  });

  it("removes a retention's intention whose person the retention would not forget now, and keeps it once it would", async () => {
    for (const [idle, expected] of [
      [40, false],
      [50, true],
    ] as const) {
      const storage = memory();
      const ledgerAdapter = memory();
      const config: Config = {
        storage,
        runtime: {
          personalData: {
            retention: "45d",
            forgetLedger: { store: ledgerAdapter, keepFor: "30d" },
          },
        },
      };
      const app = await start(config);
      await register(app, "ana");
      await app.stop();
      const ledger = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      await ledger.append([intention("ana", "retention-ana", START, { reason: "retention" })]);
      const now = new Date(START.getTime() + idle * DAY);
      expect(await pruneTenantForgetLedger({ registry, config, now })).toMatchObject({
        unapplied: expected,
      });
    }
  });

  it("refuses a registry the app would refuse, once it opens the database", async () => {
    const ledgerAdapter = memory();
    const ledger = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
    await ledger.append([intention("ana", "e-ana", START)]);
    const customer = registry.aggregates.customer;
    for (const [refused, message] of [
      [{ ...registry, aggregates: { ...registry.aggregates, other: customer } }, /defined in both/],
      [
        { ...registry, aggregates: { customer: { ...customer, stateFingerprint: "" } } },
        /Invalid registry/,
      ],
    ] as const) {
      await expect(
        pruneTenantForgetLedger({
          registry: refused as Registry,
          config: configOf(memory(), ledgerAdapter, "30d"),
          now: LATER,
        }),
      ).rejects.toThrow(message);
    }
    expect(await entriesOf(ledger)).toEqual(["ana"]);
  });
});

describe("pruning a tenant's entries in a store its configuration no longer names", () => {
  // An app that wrote to `before`, whose configuration now names `now`.
  const moved = async () => {
    const storage = memory();
    const before = memory();
    const now = memory();
    const app = await start(configOf(storage, before, "30d"));
    await register(app, "ana", "bob");
    await app.forget("ana");
    await app.runUntilIdle();
    await app.stop();
    return {
      before,
      now,
      config: configOf(storage, now, "30d"),
      left: await before.createForgetLedger({ tenant: DEFAULT_TENANT }),
      named: await now.createForgetLedger({ tenant: DEFAULT_TENANT }),
    };
  };

  it("keeps what its database lacks, though its cursor read past it, and says no app reads it there", async () => {
    const { before, config, left } = await moved();
    // Lost by a copy restored once the ledger moved, older than what the database reads again.
    const lost = entry("cy", "lost-cy", new Date(START.getTime() - DAY));
    await left.append([lost]);
    expect(await pruneTenantForgetLedger({ registry, config, store: before, now: LATER })).toEqual({
      tenant: DEFAULT_TENANT,
      before: lost.forgottenAt,
      unapplied: true,
      named: false,
      stranded: true,
    });
    expect(await entriesOf(left)).toEqual(["cy", "ana"]);
    // Where the database reads it, the same store prunes it as read past.
    expect(
      await pruneTenantForgetLedger({
        registry,
        config: configOf(memory(), before, "30d"),
        now: LATER,
      }),
    ).toMatchObject({ named: true });
  });

  it("removes what its database holds, and keeps what it lacks, stranded only while the ledger it names lacks it where its reconciliation reads", async () => {
    const { before, config, left, named } = await moved();
    // bob's forgetting, lost by a copy restored once the ledger moved.
    const lost = entry("bob", "lost-bob", new Date(START.getTime() + 60 * 60_000));
    await left.append([lost]);
    expect(await pruneTenantForgetLedger({ registry, config, store: before, now: LATER })).toEqual({
      tenant: DEFAULT_TENANT,
      before: lost.forgottenAt,
      unapplied: true,
      named: false,
      stranded: true,
    });
    expect(await entriesOf(left)).toEqual(["bob"]);
    await named.append([lost]);
    expect(
      await pruneTenantForgetLedger({ registry, config, store: before, now: LATER }),
    ).toMatchObject({ unapplied: true, named: false, stranded: false });

    // Once applied, it goes.
    await start(config).then((app) => app.stop());
    expect(await pruneTenantForgetLedger({ registry, config, store: before, now: LATER })).toEqual({
      tenant: DEFAULT_TENANT,
      before: new Date(LATER.getTime() - KEEP_FOR_MS).toISOString(),
      unapplied: false,
      named: false,
      stranded: false,
    });
    expect(await entriesOf(left)).toEqual([]);
  });

  it("prunes as named the store the configuration names, given by another definition of the same database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bounda-prune-"));
    try {
      const path = join(directory, "ledger.db");
      const { adapter: first } = createNodeSqliteAdapter(path);
      const { adapter: second } = createNodeSqliteAdapter(path);
      expect(
        await pruneTenantForgetLedger({
          registry,
          config: configOf(memory(), first, "30d"),
          store: second,
          now: LATER,
        }),
      ).toMatchObject({ named: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses, pruning nothing, when the ledger the configuration names cannot be read", async () => {
    const { before, left } = await moved();
    await left.append([entry("cy", "lost-cy", new Date(START.getTime() - DAY))]);
    const config = configOf(
      memory(),
      defineForgetLedger(() => {
        throw new Error("the ledger is gone");
      }),
      "30d",
    );
    await expect(
      pruneTenantForgetLedger({ registry, config, store: before, now: LATER }),
    ).rejects.toThrow("the ledger is gone");
    expect(await entriesOf(left)).toEqual(["cy", "ana"]);
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
    await expect(pruneTenantForgetLedger({ registry, config })).rejects.toThrow(
      /opened only by its host/,
    );
    expect(closed).toEqual(["ledger"]);
  });
});
