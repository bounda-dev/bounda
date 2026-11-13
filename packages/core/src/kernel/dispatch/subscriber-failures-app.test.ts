import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { Table } from "../../adapter/storage/table.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { PersonalDataForgottenEvent } from "../../modules/bounda-events.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { type BoundaApp, createApp } from "../app.ts";

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
          payload: ({ z }: EventPayloadArgs) => z.object({ note: z.string() }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), email: z.string() }),
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
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string(), note: z.string() }),
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
          customerId: f.string().primaryKey(),
          email: f.string(),
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
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), topic: z.string() }),
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
  personalData: { categories: { marketing: { basis: "consent", retention: "2y" } } },
} as unknown as Registry;

const SUBSCRIBER = "projection:customers";

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

const start = async (adapter: Adapter, of: Registry = registry) => {
  started += 1;
  const logger = recordingLogger();
  const app = await createApp<Registry>({
    registry: of,
    config: { storage: adapter },
    ids: createSequentialIdGenerator({ prefix: `app-${started}` }),
    clock: createFixedClock(new Date("2026-05-01T00:00:00.000Z")),
    logger,
  });
  stops.push(() => app.stop());
  return { app, logger };
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
    const [stuck] = (await app.status()).subscriberFailures;
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
    expect(await app.subscriberFailures.get("projection:nothing")).toBeNull();
    expect(accesses(logger)).toHaveLength(1);
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
      { database: "storage", scope: "storage", version: 5, latest: 5 },
      { database: "storage", scope: "checkpoints", version: 3, latest: 3 },
    ]);
    const inMemory = await start(memory());
    expect(await inMemory.app.status()).toMatchObject({
      schema: [],
      restoresFound: 0,
      subscriberFailures: [],
      personalDataBackfill: { caughtUp: false },
      forgetLedger: null,
      keyRotation: null,
      retention: { categories: [], keptBeyond: 0 },
      deadLetterRetention: null,
    });
  });

  it("names the read models' database and the ledger's apart from the storage", async () => {
    // Three databases: the same path is taken for the same database.
    const directory = mkdtempSync(join(tmpdir(), "bounda-status-"));
    const storage = createNodeSqliteAdapter(join(directory, "storage.db")).adapter;
    const readModels = createNodeSqliteAdapter(join(directory, "read-models.db")).adapter;
    const ledger = createNodeSqliteAdapter(join(directory, "ledger.db")).adapter;
    const app = await createApp<Registry>({
      registry,
      config: {
        storage,
        readModels: { customers: readModels },
        runtime: {
          personalData: { forgetLedger: { store: ledger }, retention: "30d" },
          deadLetters: { retention: "7d" },
        },
      },
      clock: createFixedClock(new Date("2026-05-01T00:00:00.000Z")),
    });
    stops.push(() => app.stop());
    await app.forget("c-0");
    await app.runUntilIdle();
    const status = await app.status();
    expect(status.schema).toEqual([
      { database: "storage", scope: "storage", version: 5, latest: 5 },
      { database: "storage", scope: "checkpoints", version: 3, latest: 3 },
      { database: "readModels.customers", scope: "checkpoints", version: 3, latest: 3 },
      { database: "forgetLedger", scope: "forget-ledger", version: 5, latest: 5 },
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
