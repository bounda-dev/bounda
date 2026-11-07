import { describe, expect, it } from "vitest";
import type { Table } from "../adapter/storage/table.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import { memory } from "../memory/index.ts";
import { MAX_ACCESS_PERSONS, type OnPersonalDataAccessArgs } from "../modules/audit.ts";
import type { EventPayloadArgs, PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { createTestApp } from "../testing/index.ts";
import { createApp } from "./app.ts";
import { createRecordingLogger } from "./test-support.ts";

interface CustomerRow {
  readonly customerId: string;
  readonly email: string;
  readonly plan: string;
}

type Events = Record<string, (payload?: unknown) => unknown>;

const registryWith = (audit?: Registry["audit"]) =>
  ({
    aggregates: {
      customer: {
        events: {
          customerRegistered: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({ email: personal(z.email()), plan: z.string() }),
            evolve: () => ({}),
          },
        },
        commands: {
          registerCustomer: {
            module: {
              payload: ({ z }: PayloadArgs) =>
                z.object({ customerId: z.string(), email: z.email(), plan: z.string() }),
              handler: ({
                command,
                events,
              }: {
                command: { payload: { email: string; plan: string } };
                events: Events;
              }) => [events.customerRegistered?.(command.payload)],
            },
          },
        },
        policies: {
          welcomeOnCustomerRegistered: {
            module: {
              handler: () => {
                throw new Error("no mailbox");
              },
            },
          },
        },
        processes: {},
      },
    },
    readModels: {
      customerDirectory: {
        view: {
          fields: ({ f }: FieldsArgs) => ({
            customerId: f.string().primaryKey().person(),
            email: f.string().personal(),
            plan: f.string().index(),
          }),
        },
        projections: {
          customer: {
            customerRegistered: {
              project: ({
                event,
                table,
              }: {
                event: { aggregateId: string; payload: { email: string; plan: string } };
                table: Table<CustomerRow>;
              }) => table.upsert({ customerId: event.aggregateId, ...event.payload }),
            },
          },
          bounda: { personalDataForgotten: { project: () => undefined } },
        },
        queries: {
          customersOnPlan: {
            payload: ({ z }: PayloadArgs) => z.object({ plan: z.string() }),
            repository: ({ plan, table }: { plan: string; table: Table<CustomerRow> }) =>
              table.findMany({
                where: { plan },
                orderBy: { field: "customerId", direction: "asc" },
              }),
            handler: ({ repositoryData }: { repositoryData: readonly CustomerRow[] }) =>
              repositoryData.map((row) => row.email),
          },
          customerCount: {
            handler: ({ table }: { table: Table<CustomerRow> }) => table.count(),
          },
        },
      },
      // A person field and nothing personal: an id, which no query records.
      customerPlans: {
        view: {
          fields: ({ f }: FieldsArgs) => ({
            customerId: f.string().primaryKey().person(),
            plan: f.string(),
          }),
        },
        projections: {},
        queries: {
          plansOf: {
            handler: ({ table }: { table: Table<{ customerId: string; plan: string }> }) =>
              table.findMany(),
          },
        },
      },
      planStats: {
        view: {
          fields: ({ f }: FieldsArgs) => ({
            plan: f.string().primaryKey(),
            customers: f.number(),
          }),
        },
        projections: {},
        queries: {
          // Composes a query of a read model with personal fields, which records itself.
          proCustomers: {
            handler: ({
              queries,
            }: {
              queries: Record<string, (payload: unknown) => Promise<unknown>>;
            }) => queries.customersOnPlan?.({ plan: "pro" }),
          },
        },
      },
    },
    ...(audit === undefined ? {} : { audit }),
  }) satisfies Registry;

const setUp = async () => {
  const records: OnPersonalDataAccessArgs[] = [];
  const sink = { failing: false };
  // The project's app/audit.ts, which a test app leaves alone.
  const registry = registryWith({
    onPersonalDataAccess: () => {
      throw new Error("app/audit.ts called from a test app");
    },
  });
  const test = await createTestApp({
    registry,
    config: { runtime: { policies: { retry: { strategy: "none" } } } },
    env: { AUDIT_URL: "https://audit.example" },
    tenant: "shop-1",
    onPersonalDataAccess: async (args) => {
      if (sink.failing) throw new Error("audit sink down");
      records.push(args);
    },
  });
  const register = async (customerId: string, plan = "pro") => {
    await test.app.commands.registerCustomer({
      customerId,
      email: `${customerId}@example.com`,
      plan,
    });
  };
  return {
    ...test,
    records,
    sink,
    register,
    accesses: () => records.map(({ access }) => access),
  };
};

const AT = "2026-01-01T00:00:00.000Z";

describe("the access log", () => {
  it("records an export with its actor, the person and how much it handed out", async () => {
    const { app, register, records, accesses } = await setUp();
    await register("ana");
    await app.runUntilIdle();

    const exported = await app.as("operator-1").exportPersonalData("ana");
    expect(exported.readModels).toEqual({
      customerDirectory: [{ key: "ana", data: { email: "ana@example.com" } }],
      customerPlans: [],
    });
    expect(accesses()).toEqual([
      {
        operation: "exportPersonalData",
        actor: "operator-1",
        persons: ["ana"],
        personCount: 1,
        at: AT,
        detail: { events: 1, scheduledCommands: 0, deadLetters: 1, readModelRows: 1 },
      },
    ]);
    expect(records[0]).toMatchObject({
      env: { AUDIT_URL: "https://audit.example" },
      tenant: "shop-1",
    });
  });

  it("records each dead-letter call that opens letters, naming the persons they are about", async () => {
    const { app, register, accesses } = await setUp();
    await register("ana");
    await register("bo");
    await app.runUntilIdle();
    const operator = app.as("operator-1");

    const letters = await operator.deadLetters.list();
    const [first, second] = letters;
    if (first === undefined || second === undefined) throw new Error("expected two letters");
    expect(await app.deadLetters.count()).toBe(2);
    await app.deadLetters.get(first.id);
    expect(await app.deadLetters.get("missing")).toBeNull();
    await expect(operator.deadLetters.retry(first.id)).rejects.toThrow("no mailbox");
    await operator.deadLetters.discard(second.id);

    expect(accesses()).toEqual([
      {
        operation: "deadLetters.list",
        actor: "operator-1",
        persons: ["ana", "bo"],
        personCount: 2,
        at: AT,
        detail: { letters: 2 },
      },
      {
        operation: "deadLetters.get",
        actor: null,
        persons: ["ana"],
        personCount: 1,
        at: AT,
        detail: { letter: first.id },
      },
      {
        operation: "deadLetters.retry",
        actor: "operator-1",
        persons: ["ana"],
        personCount: 1,
        at: AT,
        detail: { letter: first.id },
      },
      {
        operation: "deadLetters.discard",
        actor: "operator-1",
        persons: ["bo"],
        personCount: 1,
        at: AT,
        detail: { letter: second.id },
      },
    ]);
  });

  it("records a query of a read model with personal fields, naming the persons of the rows it read", async () => {
    const { app, register, accesses } = await setUp();
    await register("ana");
    await register("bo", "free");
    await register("cy");
    await app.runUntilIdle();

    expect(await app.as("operator-1").queries.customersOnPlan({ plan: "pro" })).toEqual([
      "ana@example.com",
      "cy@example.com",
    ]);
    expect(await app.queries.customerCount()).toBe(3);
    expect(await app.queries.plansOf()).toEqual([]);
    expect(await app.queries.customersOnPlan({ plan: "gold" })).toEqual([]);

    expect(accesses()).toEqual([
      {
        operation: "query",
        actor: "operator-1",
        persons: ["ana", "cy"],
        personCount: 2,
        at: AT,
        detail: { query: "customersOnPlan", readModel: "customerDirectory" },
      },
      {
        operation: "query",
        actor: null,
        persons: [],
        personCount: 0,
        at: AT,
        detail: { query: "customerCount", readModel: "customerDirectory" },
      },
      {
        operation: "query",
        actor: null,
        persons: [],
        personCount: 0,
        at: AT,
        detail: { query: "customersOnPlan", readModel: "customerDirectory" },
      },
    ]);
  });

  it("records a query that another composes, as the actor of the outer one, and not the outer one when its read model has no personal field", async () => {
    const { app, register, accesses } = await setUp();
    await register("ana");
    await app.runUntilIdle();

    expect(await app.as("operator-1").queries.proCustomers()).toEqual(["ana@example.com"]);
    expect(accesses()).toEqual([
      expect.objectContaining({
        operation: "query",
        actor: "operator-1",
        persons: ["ana"],
        detail: { query: "customersOnPlan", readModel: "customerDirectory" },
      }),
    ]);
  });

  it("names each person once and at most so many, counting them all", async () => {
    const { app, register, accesses } = await setUp();
    const ids = Array.from(
      { length: MAX_ACCESS_PERSONS + 2 },
      (_, index) => `c-${String(index).padStart(3, "0")}`,
    );
    for (const id of ids) await register(id);
    await app.runUntilIdle();

    await app.queries.customersOnPlan({ plan: "pro" });
    const [access] = accesses();
    expect(access?.persons).toEqual(ids.slice(0, MAX_ACCESS_PERSONS));
    expect(access?.personCount).toBe(ids.length);
  });

  it("fails the call when the hook throws, and retries or discards nothing", async () => {
    const { app, register, sink } = await setUp();
    await register("ana");
    await app.runUntilIdle();
    const [letter] = await app.deadLetters.list();
    if (letter === undefined) throw new Error("expected a letter");
    sink.failing = true;

    await expect(app.exportPersonalData("ana")).rejects.toThrow("audit sink down");
    await expect(app.queries.customersOnPlan({ plan: "pro" })).rejects.toThrow("audit sink down");
    await expect(app.deadLetters.list()).rejects.toThrow("audit sink down");
    await expect(app.deadLetters.get(letter.id)).rejects.toThrow("audit sink down");
    await expect(app.deadLetters.retry(letter.id)).rejects.toThrow("audit sink down");
    await expect(app.deadLetters.discard(letter.id)).rejects.toThrow("audit sink down");
    expect(await app.deadLetters.count({ status: "failed" })).toBe(1);
    expect(await app.queries.customerCount().catch((error: unknown) => error)).toEqual(
      new Error("audit sink down"),
    );
  });

  it("goes to app/audit.ts in an app that is not a test's", async () => {
    const records: OnPersonalDataAccessArgs[] = [];
    const app = await createApp({
      registry: registryWith({
        onPersonalDataAccess: (args) => {
          records.push(args);
        },
      }),
      config: { storage: memory() },
    });
    await app.as("operator-1").exportPersonalData("ana");
    expect(records.map(({ access }) => access.operation)).toEqual(["exportPersonalData"]);
    await app.stop();
  });

  it("goes to the app's logger at info without app/audit.ts, and in a test app without a hook of the test's", async () => {
    const { logger, entries } = createRecordingLogger();
    const { app } = await createTestApp({
      registry: registryWith({
        onPersonalDataAccess: () => {
          throw new Error("app/audit.ts called from a test app");
        },
      }),
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
      logger,
    });
    await app.commands.registerCustomer({
      customerId: "ana",
      email: "ana@example.com",
      plan: "pro",
    });
    await app.runUntilIdle();

    await app.as("operator-1").queries.customersOnPlan({ plan: "pro" });
    expect(entries.filter((entry) => entry.message === "personal data accessed")).toEqual([
      {
        level: "info",
        message: "personal data accessed",
        fields: {
          operation: "query",
          actor: "operator-1",
          persons: ["ana"],
          personCount: 1,
          at: AT,
          detail: { query: "customersOnPlan", readModel: "customerDirectory" },
        },
      },
    ]);
  });

  it("refuses an audit module without onPersonalDataAccess", async () => {
    await expect(createTestApp({ registry: registryWith({} as never) })).rejects.toThrow(
      new ConfigurationError(
        'Invalid registry:\n  audit: missing export "onPersonalDataAccess" (expected a function)',
      ),
    );
  });
});
