import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { Table } from "../../adapter/storage/table.ts";
import {
  DEFAULT_DEAD_LETTER_RETENTION_MS,
  DEFAULT_SUBSCRIBER_FAILURE_RETENTION_MS,
} from "../../config/defaults.ts";
import type { RuntimeConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { PersonalDataForgottenEvent } from "../../modules/bounda-events.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { HELD_RECHECK_MS } from "../personal-data/held-text.ts";
import { masterKey } from "../personal-data/master-key.ts";
import { readPart } from "../test-support.ts";

// The projection quotes the personal field it read, as a careless one does, while `failing.on`.
const failing = { on: false };

interface CustomerRow {
  readonly customerId: string;
  readonly email: string;
}

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.string()) }),
          evolve: () => ({}),
        },
        customerNoted: {
          payload: ({ z, notPersonal }: EventPayloadArgs) =>
            z.object({ note: notPersonal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), email: notPersonal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ email: command.payload.email })],
          },
        },
        noteCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), note: notPersonal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { note: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerNoted?.({ note: command.payload.note })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().notPersonal(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: StoredEvent<"CustomerRegistered", { email: string | null }>;
              table: Table<CustomerRow>;
            }) => {
              if (failing.on) throw new Error(`cannot project ${event.payload.email ?? "nobody"}`);
              await table.upsert({
                customerId: event.aggregateId,
                email: event.payload.email ?? "",
              });
            },
          },
          customerNoted: {
            project: async ({
              event,
            }: {
              event: StoredEvent<"CustomerNoted", { note: string }>;
            }) => {
              if (failing.on) throw new Error(`cannot note ${event.payload.note}`);
            },
          },
        },
        bounda: {
          personalDataForgotten: {
            project: async ({
              event,
              table,
            }: {
              event: PersonalDataForgottenEvent;
              table: Table<CustomerRow>;
            }) => {
              await table.delete({ customerId: event.payload.personId });
            },
          },
        },
      },
      queries: {},
    },
  },
} as unknown as Registry;

// The same app, with a marketing category its customers subscribe under.
const customer = (registry.aggregates as Record<string, Registry["aggregates"][string]>).customer;
const categorized = {
  ...registry,
  aggregates: {
    customer: {
      ...customer,
      events: {
        ...customer?.events,
        customerSubscribed: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ topic: personal(z.string(), { category: "marketing" }) }),
          evolve: () => ({}),
        },
      },
      commands: {
        ...customer?.commands,
        subscribeCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), topic: notPersonal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { topic: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerSubscribed?.({ topic: command.payload.topic })],
          },
        },
      },
    },
  },
  personalData: {
    automatedDecisions: {},
    categories: {
      marketing: {
        basis: "consent",
        retention: "2y",
        purposes: ["Serve the person"],
        sources: ["data-subject"],
      },
    },
  },
} as unknown as Registry;

const SUBSCRIBER = "projection:customers";
const DAY = 86_400_000;

interface Logged {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields | undefined;
}

const recordingLogger = (): Logger & { readonly logged: Logged[] } => {
  const logged: Logged[] = [];
  const at = (level: string) => (message: string, fields?: LogFields) => {
    logged.push({ level, message, fields });
  };
  return { logged, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  failing.on = false;
  for (const stop of stops.splice(0)) await stop();
});

let started = 0;

const start = async (adapter: Adapter, of: Registry = registry, runtime?: RuntimeConfig) => {
  started += 1;
  const logger = recordingLogger();
  const clock = createFixedClock(new Date("2026-05-01T00:00:00.000Z"));
  const app = await createApp<Registry>({
    registry: of,
    config: { storage: adapter, ...(runtime === undefined ? {} : { runtime }) },
    ids: createSequentialIdGenerator({ prefix: `app-${started}` }),
    clock,
    logger,
  });
  stops.push(() => app.stop());
  return { app, logger, clock };
};

const register = (app: BoundaApp<Registry>, customerId: string) =>
  app.commands.registerCustomer?.({ customerId, email: `${customerId}@example.com` });

const accesses = (logger: { readonly logged: Logged[] }): PersonalDataAccess[] =>
  logger.logged
    .filter(({ message }) => message === "personal data accessed")
    .map(({ fields }) => fields as unknown as PersonalDataAccess);

describe.each([
  ["memory", () => memory()],
  ["SQLite", () => createNodeSqliteAdapter().adapter],
])("the last failure of each subscriber, on %s", (_name, adapterOf) => {
  it("keeps the text of a projection's failure sealed under the event's person, out of the logs", async () => {
    const adapter = adapterOf();
    const { app, logger } = await start(adapter);
    failing.on = true;
    await register(app, "c-1");
    await app.runUntilIdle({ maxPasses: 3 });
    const stored = await (await adapter.createStorage()).subscriberFailures.get(SUBSCRIBER);
    expect(stored).toMatchObject({
      eventType: "CustomerRegistered",
      person: "c-1",
      errorName: "Error",
      errorMessage: { $personal: { person: "c-1" } },
      resolvedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain("c-1@example.com");
    expect(JSON.stringify(logger.logged)).not.toContain("c-1@example.com");

    const status = await app.status();
    expect(status.subscriberFailures).toEqual([
      expect.objectContaining({ subscriber: SUBSCRIBER, person: "c-1", current: true }),
    ]);
    expect(JSON.stringify(status)).not.toContain("c-1@example.com");
    expect(accesses(logger)).toEqual([]);

    const [opened] = await app.as("operator-1").subscriberFailures.list();
    expect(opened).toMatchObject({
      subscriber: SUBSCRIBER,
      errorMessage: "cannot project c-1@example.com",
      errorStack: expect.stringContaining("cannot project c-1@example.com"),
    });
    expect(accesses(logger)).toEqual([
      expect.objectContaining({
        operation: "subscriberFailures.list",
        actor: "operator-1",
        persons: ["c-1"],
        detail: { failures: 1 },
        outcome: "ok",
      }),
    ]);
  });

  it("counts the failures on one event, and resolves the failure once the subscriber gets past it", async () => {
    const adapter = adapterOf();
    const { app, logger } = await start(adapter);
    failing.on = true;
    await register(app, "c-1");
    await app.runUntilIdle({ maxPasses: 3 });
    const [stuck] = readPart((await app.status()).subscriberFailures);
    expect(stuck?.attempts).toBeGreaterThan(1);
    failing.on = false;
    await app.runUntilIdle();
    expect((await app.status()).subscriberFailures).toEqual([
      expect.objectContaining({ current: false, resolvedAt: "2026-05-01T00:00:00.000Z" }),
    ]);
    expect(await app.subscriberFailures.get(SUBSCRIBER)).toMatchObject({
      errorMessage: "cannot project c-1@example.com",
    });
    expect(accesses(logger).at(-1)).toMatchObject({
      operation: "subscriberFailures.get",
      detail: { subscriber: SUBSCRIBER },
      persons: ["c-1"],
    });
    // Found nothing, recorded as a query that matches no row is.
    expect(await app.subscriberFailures.get("projection:nothing")).toBeNull();
    expect(accesses(logger)).toHaveLength(2);
    expect(accesses(logger).at(-1)).toMatchObject({
      operation: "subscriberFailures.get",
      detail: { subscriber: "projection:nothing" },
      persons: [],
      outcome: "ok",
    });
  });

  it("reads the text as null once the person is forgotten, and hands it to their export", async () => {
    const adapter = adapterOf();
    const { app } = await start(adapter);
    failing.on = true;
    await register(app, "c-1");
    await app.runUntilIdle({ maxPasses: 3 });
    expect((await app.exportPersonalData("c-1")).subscriberFailures).toEqual([
      {
        subscriber: SUBSCRIBER,
        eventId: expect.any(String),
        eventType: "CustomerRegistered",
        errorMessage: "cannot project c-1@example.com",
        errorStack: expect.stringContaining("cannot project"),
        restricted: [],
        withheld: [],
      },
    ]);
    expect((await app.exportPersonalData("c-2")).subscriberFailures).toEqual([]);
    await app.forget("c-1");
    expect(await app.subscriberFailures.get(SUBSCRIBER)).toMatchObject({
      person: "c-1",
      errorMessage: null,
      errorStack: null,
    });
  });

  it("reads the text as null once any category of the person is forgotten, since it may quote any", async () => {
    const adapter = adapterOf();
    const { app } = await start(adapter, categorized);
    await app.commands.subscribeCustomer?.({ customerId: "c-1", topic: "shoes" });
    failing.on = true;
    await register(app, "c-1");
    await app.runUntilIdle({ maxPasses: 3 });
    expect(await app.subscriberFailures.get(SUBSCRIBER)).toMatchObject({
      errorMessage: "cannot project c-1@example.com",
    });
    await app.forget("c-1", { categories: ["marketing"] });
    expect(await app.subscriberFailures.get(SUBSCRIBER)).toMatchObject({
      person: "c-1",
      errorMessage: null,
      errorStack: null,
    });
    expect((await app.exportPersonalData("c-1")).events.map(({ data }) => data)).toEqual([
      { topic: null },
      { email: "c-1@example.com" },
      {},
    ]);
  });

  it("keeps in the clear the text of a failure on an event that names nobody", async () => {
    const adapter = adapterOf();
    const { app } = await start(adapter);
    failing.on = true;
    await app.commands.noteCustomer?.({ customerId: "c-1", note: "late" });
    await app.runUntilIdle({ maxPasses: 3 });
    expect(await (await adapter.createStorage()).subscriberFailures.get(SUBSCRIBER)).toMatchObject({
      person: null,
      errorMessage: "cannot note late",
    });
  });

  it("purges a failure past runtime.subscriberFailures.retention, held while its person is restricted", async () => {
    const adapter = adapterOf();
    const { app, clock } = await start(adapter, registry, {
      subscriberFailures: { retention: "1d" },
    });
    failing.on = true;
    await register(app, "c-1");
    await app.runUntilIdle({ maxPasses: 3 });
    failing.on = false;
    await app.runUntilIdle();
    const resolvedAt = clock.now().getTime();
    const due = new Date(resolvedAt + DAY);
    expect((await app.status()).subscriberFailureRetention).toEqual({
      retentionMs: DAY,
      nextDueAt: due.toISOString(),
      held: 0,
    });
    expect(await app.nextDueAt()).toEqual(due);
    await app.restrict("c-1", { ground: "legal-claims" });
    clock.set(due);
    await app.runUntilIdle();
    expect((await app.status()).subscriberFailures).toHaveLength(1);
    expect((await app.status()).subscriberFailureRetention).toMatchObject({ held: 1 });
    await app.unrestrict("c-1", { notice: "given" });
    clock.set(new Date(due.getTime() + HELD_RECHECK_MS));
    await app.runUntilIdle();
    expect((await app.status()).subscriberFailures).toEqual([]);
    expect(await (await adapter.createStorage()).subscriberFailures.list()).toEqual([]);
    expect(await app.nextDueAt()).toBeNull();
  });

  it("keeps a failure the subscriber is stuck on, and purges it once the app no longer runs the subscriber", async () => {
    const adapter = adapterOf();
    const first = await start(adapter);
    failing.on = true;
    await register(first.app, "c-1");
    await first.app.runUntilIdle({ maxPasses: 3 });
    const failedAt = Date.parse(
      readPart((await first.app.status()).subscriberFailures)[0]?.lastFailedAt ?? "",
    );
    first.clock.set(new Date(failedAt + DEFAULT_SUBSCRIBER_FAILURE_RETENTION_MS));
    expect(await first.app.nextDueAt()).toBeNull();
    await first.app.stop();
    const second = await start(adapter, { ...registry, readModels: {} } as Registry);
    expect(await second.app.nextDueAt()).toEqual(
      new Date(failedAt + DEFAULT_SUBSCRIBER_FAILURE_RETENTION_MS),
    );
    second.clock.set(new Date(failedAt + DEFAULT_SUBSCRIBER_FAILURE_RETENTION_MS));
    await second.app.runUntilIdle();
    expect(await (await adapter.createStorage()).subscriberFailures.list()).toEqual([]);
  });

  it("is resolved by an instance that gets the subscriber past it, though another met it", async () => {
    const adapter = adapterOf();
    const first = await start(adapter);
    failing.on = true;
    await register(first.app, "c-1");
    await first.app.runUntilIdle({ maxPasses: 3 });
    await first.app.stop();
    failing.on = false;
    const second = await start(adapter);
    await second.app.runUntilIdle();
    expect(await (await adapter.createStorage()).subscriberFailures.get(SUBSCRIBER)).toMatchObject({
      resolvedAt: "2026-05-01T00:00:00.000Z",
    });
  });
});

describe("the status of the app", () => {
  it("names the version of every scope where it lives, and nothing of a store without tables", async () => {
    const { adapter } = createNodeSqliteAdapter();
    const { app } = await start(adapter);
    expect((await app.status()).schema).toEqual([
      { database: "storage", scope: "storage", version: 11, latest: 11 },
      { database: "storage", scope: "checkpoints", version: 5, latest: 5 },
    ]);
    const inMemory = await start(memory());
    expect(await inMemory.app.status()).toMatchObject({
      schema: [],
      restoresFound: 0,
      subscriberFailures: [],
      personalDataBackfill: { caughtUp: false },
      forgetLedger: null,
      tenant: { tenant: "default", forgottenAt: null, previous: [] },
      keyRotation: { previous: [], pending: 0 },
      retention: { categories: [], keptBeyond: 0 },
      deadLetterRetention: {
        retentionMs: DEFAULT_DEAD_LETTER_RETENTION_MS,
        nextDueAt: null,
        held: 0,
      },
      subscriberFailureRetention: {
        retentionMs: DEFAULT_SUBSCRIBER_FAILURE_RETENTION_MS,
        nextDueAt: null,
        held: 0,
      },
    });
  });

  it("names the read models' database and the ledger's apart from the storage", async () => {
    // Three databases: the same path is taken for the same database.
    const directory = mkdtempSync(join(tmpdir(), "bounda-status-"));
    const storage = createNodeSqliteAdapter(join(directory, "storage.db")).adapter;
    const readModels = createNodeSqliteAdapter(join(directory, "read-models.db")).adapter;
    const ledger = createNodeSqliteAdapter(join(directory, "ledger.db")).adapter;
    const keys = createNodeSqliteAdapter(join(directory, "keys.db")).adapter;
    const app = await createApp<Registry>({
      registry,
      config: {
        storage,
        readModels: { customers: readModels },
        runtime: {
          personalData: {
            forgetLedger: { store: ledger },
            retention: "30d",
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
            tenantKeys: keys,
          },
          deadLetters: { retention: "7d" },
        },
      },
      env: { BOUNDA_MASTER_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString("base64") },
      clock: createFixedClock(new Date("2026-05-01T00:00:00.000Z")),
    });
    stops.push(() => app.stop());
    await app.forget("c-0");
    await app.runUntilIdle();
    const status = await app.status();
    expect(status.schema).toEqual([
      { database: "storage", scope: "storage", version: 11, latest: 11 },
      { database: "storage", scope: "checkpoints", version: 5, latest: 5 },
      { database: "readModels.customers", scope: "checkpoints", version: 5, latest: 5 },
      { database: "forgetLedger", scope: "forget-ledger", version: 13, latest: 13 },
      { database: "tenantKeys", scope: "tenant-keys", version: 1, latest: 1 },
    ]);
    expect(status).toMatchObject({
      forgetLedger: { reconciled: true, held: null },
      retention: {
        categories: [{ category: "default", retention: "30d", due: 0, nextDueAt: null }],
        keptBeyond: 0,
      },
      deadLetterRetention: { nextDueAt: null },
    });
  });
});
