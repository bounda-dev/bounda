import { describe, expect, it, vi } from "vitest";
import type { Adapter } from "../adapter/adapter.ts";
import type { Table } from "../adapter/storage/table.ts";
import { createFixedClock } from "../contracts/clock.ts";
import {
  ConcurrencyError,
  ConfigurationError,
  ReadModelRestoringError,
  ValidationError,
} from "../contracts/errors.ts";
import { memory } from "../memory/index.ts";
import {
  type AuditModule,
  MAX_ACCESS_PERSONS,
  type OnPersonalDataAccessArgs,
  type PersonalDataAccess,
} from "../modules/audit.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../modules/payload.ts";
import { RESTRICTION_GROUNDS } from "../modules/personal-data.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { createTestApp } from "../testing/index.ts";
import { createApp } from "./app.ts";
import { DEFAULT_TENANT } from "./personal-data/tenant-keys.ts";
import { streamMarkOf } from "./read-model/stream-marks.ts";
import { GENERATION_INTERVAL_MS } from "./shared/restores.ts";
import { createRecordingLogger } from "./test-support.ts";

interface CustomerRow {
  readonly customerId: string;
  readonly email: string;
  readonly plan: string;
}

type Events = Record<string, (payload?: unknown) => unknown>;

// The host log is another test's.
const registryWith = (audit?: Pick<AuditModule, "onPersonalDataAccess">) =>
  ({
    aggregates: {
      customer: {
        events: {
          customerRegistered: {
            payload: ({ z, personal, notPersonal }: EventPayloadArgs) =>
              z.object({ email: personal(z.email()), plan: notPersonal(z.string()) }),
            evolve: () => ({}),
          },
        },
        commands: {
          registerCustomer: {
            module: {
              payload: ({ z, notPersonal }: CommandPayloadArgs) =>
                z.object({
                  customerId: notPersonal(z.string()),
                  email: notPersonal(z.email()),
                  plan: notPersonal(z.string()),
                }),
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
            plan: f.string().index().notPersonal(),
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
          emailCheck: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: async ({
              query,
              table,
            }: {
              query: { payload: { customerId: string } };
              table: Table<CustomerRow>;
            }) => {
              const found = await table.findOne({ customerId: query.payload.customerId });
              throw new Error(`cannot reach ${found?.email}`);
            },
          },
          customersByDriver: {
            repository: ({ client }: { client: { raw: Table<CustomerRow> } }) =>
              client.raw.findMany(),
            handler: ({ repositoryData }: { repositoryData: readonly CustomerRow[] }) =>
              repositoryData.length,
          },
        },
      },
      // A person field and nothing personal: an id, which no query records.
      customerPlans: {
        view: {
          fields: ({ f }: FieldsArgs) => ({
            customerId: f.string().primaryKey().person(),
            plan: f.string().notPersonal(),
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
            plan: f.string().primaryKey().notPersonal(),
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
    ...(audit === undefined ? {} : { audit: { onHostRejection: () => {}, ...audit } }),
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
const DIRECTORY = "projection:customerDirectory";

describe("the access log", () => {
  it("records an export with its actor, the person and how much it handed out", async () => {
    const { app, register, records, accesses } = await setUp();
    await register("ana");
    await app.runUntilIdle();

    const exported = await app.as("operator-1").exportPersonalData("ana");
    expect(exported.readModels).toEqual({
      customerDirectory: [
        {
          key: "ana",
          data: { email: "ana@example.com" },
          categories: { email: "default" },
          restricted: [],
        },
      ],
      customerPlans: [],
    });
    const exportId = expect.any(String);
    const record = (outcome: string, handed: number) => ({
      operation: "exportPersonalData",
      actor: "operator-1",
      persons: ["ana"],
      personCount: 1,
      at: AT,
      outcome,
      errorName: null,
      errorCode: null,
      restricted: null,
      detail: {
        exportId,
        redactions: 0,
        events: handed,
        scheduledCommands: 0,
        deadLetters: handed,
        subscriberFailures: 0,
        answers: 0,
        readModelRows: handed,
        recipients: 0,
        withheld: 0,
        includeWithheld: false,
      },
    });
    expect(accesses()).toEqual([record("started", 0), record("ok", 1)]);
    const [started, ended] = accesses();
    expect(started?.operation === "exportPersonalData" && started.detail.exportId).toBe(
      ended?.operation === "exportPersonalData" && ended.detail.exportId,
    );
    await app.exportPersonalData("ana");
    expect(
      new Set(
        accesses().map((access) =>
          access.operation === "exportPersonalData" ? access.detail.exportId : null,
        ),
      ).size,
    ).toBe(2);
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
        outcome: "ok",
        errorName: null,
        errorCode: null,
        restricted: null,
        detail: { letters: 2 },
      },
      {
        operation: "deadLetters.get",
        actor: null,
        persons: ["ana"],
        personCount: 1,
        at: AT,
        outcome: "ok",
        errorName: null,
        errorCode: null,
        restricted: null,
        detail: { letter: first.id },
      },
      // Found nothing, recorded as a query that matches no row is.
      {
        operation: "deadLetters.get",
        actor: null,
        persons: [],
        personCount: 0,
        at: AT,
        outcome: "ok",
        errorName: null,
        errorCode: null,
        restricted: null,
        detail: { letter: "missing" },
      },
      {
        operation: "deadLetters.retry",
        actor: "operator-1",
        persons: ["ana"],
        personCount: 1,
        at: AT,
        outcome: "failed",
        errorName: "Error",
        errorCode: null,
        restricted: null,
        detail: { letter: first.id },
      },
      {
        operation: "deadLetters.discard",
        actor: "operator-1",
        persons: ["bo"],
        personCount: 1,
        at: AT,
        outcome: "ok",
        errorName: null,
        errorCode: null,
        restricted: null,
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
    // A person field and nothing personal, recorded once restricted rows are asked for.
    expect(await app.queries.plansOf(undefined, { includeRestricted: "legal-claims" })).toEqual([]);

    expect(accesses()).toEqual([
      {
        operation: "query",
        actor: "operator-1",
        persons: ["ana", "cy"],
        personCount: 2,
        at: AT,
        outcome: "ok",
        errorName: null,
        errorCode: null,
        restricted: null,
        unattributed: false,
        detail: { query: "customersOnPlan", readModel: "customerDirectory" },
      },
      {
        operation: "query",
        actor: null,
        persons: [],
        personCount: 0,
        at: AT,
        outcome: "ok",
        errorName: null,
        errorCode: null,
        restricted: null,
        unattributed: false,
        detail: { query: "customerCount", readModel: "customerDirectory" },
      },
      {
        operation: "query",
        actor: null,
        persons: [],
        personCount: 0,
        at: AT,
        outcome: "ok",
        errorName: null,
        errorCode: null,
        restricted: null,
        unattributed: false,
        detail: { query: "customersOnPlan", readModel: "customerDirectory" },
      },
      {
        operation: "query",
        actor: null,
        persons: [],
        personCount: 0,
        at: AT,
        outcome: "ok",
        errorName: null,
        errorCode: null,
        restricted: { basis: "legal-claims", persons: [], personCount: 0 },
        unattributed: false,
        detail: { query: "plansOf", readModel: "customerPlans" },
      },
    ]);
  });

  it("records a query that fails after reading, whose error may quote what it read, as failed", async () => {
    const { app, register, accesses } = await setUp();
    await register("ana");
    await app.runUntilIdle();

    await expect(app.as("operator-1").queries.emailCheck({ customerId: "ana" })).rejects.toThrow(
      "cannot reach ana@example.com",
    );
    await expect(app.queries.emailCheck({} as never)).rejects.toThrow();
    expect(accesses()).toEqual([
      {
        operation: "query",
        actor: "operator-1",
        persons: ["ana"],
        personCount: 1,
        at: AT,
        outcome: "failed",
        errorName: "Error",
        errorCode: null,
        restricted: null,
        unattributed: false,
        detail: { query: "emailCheck", readModel: "customerDirectory" },
      },
      // Refused before it read, naming no one.
      {
        operation: "query",
        actor: null,
        persons: [],
        personCount: 0,
        at: AT,
        outcome: "refused",
        errorName: "ValidationError",
        errorCode: "VALIDATION_FAILED",
        restricted: null,
        unattributed: false,
        detail: { query: "emailCheck", readModel: "customerDirectory" },
      },
    ]);
  });

  it("records each call refused before it reads as refused, naming no one but the person it names, and the basis it asked on when it is one", async () => {
    const { app, register, accesses } = await setUp();
    await register("ana");
    await app.runUntilIdle();
    const operator = app.as("operator-1");
    const [letter] = await operator.deadLetters.list();
    if (letter === undefined) throw new Error("expected a letter");
    await operator.deadLetters.discard(letter.id);
    const curiosity = { includeRestricted: "curiosity" as never };
    const refused = (
      operation: string,
      detail: unknown,
      restricted: unknown = null,
      error: { readonly errorName: string; readonly errorCode: string | null } = {
        errorName: "ValidationError",
        errorCode: "VALIDATION_FAILED",
      },
    ) => ({
      operation,
      actor: "operator-1",
      persons: [],
      personCount: 0,
      at: AT,
      outcome: "refused",
      ...error,
      restricted,
      ...(operation === "query" ? { unattributed: false } : {}),
      detail,
    });
    const before = accesses().length;

    await expect(
      operator.queries.customersOnPlan({ plan: 1 } as never, { includeRestricted: "legal-claims" }),
    ).rejects.toThrow();
    await expect(operator.queries.customersOnPlan({ plan: "pro" }, curiosity)).rejects.toThrow(
      "names a basis restricted data is not read on",
    );
    await expect(operator.deadLetters.list(undefined, curiosity)).rejects.toThrow(
      "names a basis restricted data is not read on",
    );
    await expect(app.deadLetters.get(letter.id, curiosity)).rejects.toThrow(
      "names a basis restricted data is not read on",
    );
    await expect(operator.deadLetters.retry(letter.id)).rejects.toThrow("discarded");
    await expect(operator.deadLetters.discard("missing")).rejects.toThrow("not found");
    await expect(operator.subscriberFailures.list(curiosity)).rejects.toThrow(
      "names a basis restricted data is not read on",
    );
    await expect(operator.subscriberFailures.get("projection:any", curiosity)).rejects.toThrow(
      "names a basis restricted data is not read on",
    );
    await expect(operator.recipientsOf(undefined as never)).rejects.toThrow(
      "recipientsOf needs the id of the person",
    );

    const query = { query: "customersOnPlan", readModel: "customerDirectory" };
    expect(accesses().slice(before)).toEqual([
      refused("query", query, { basis: "legal-claims", persons: [], personCount: 0 }),
      refused("query", query),
      refused("deadLetters.list", { letters: 0 }),
      { ...refused("deadLetters.get", { letter: letter.id }), actor: null },
      refused("deadLetters.retry", { letter: letter.id }, null, {
        errorName: "DeadLetterSettledError",
        errorCode: "DEAD_LETTER_SETTLED",
      }),
      refused("deadLetters.discard", { letter: "missing" }, null, {
        errorName: "NotFoundError",
        errorCode: "NOT_FOUND",
      }),
      refused("subscriberFailures.list", { failures: 0 }),
      refused("subscriberFailures.get", { subscriber: "projection:any" }),
      refused("recipientsOf", null),
    ]);
  });

  it("records a read of stored letters or failures that fails before it opened any as refused, naming no one", async () => {
    const base = memory();
    const down = new Error("store down");
    const failing: Adapter = {
      ...base,
      createStorage: async () => {
        const storage = await base.createStorage();
        return {
          ...storage,
          deadLetterStore: { ...storage.deadLetterStore, list: () => Promise.reject(down) },
          subscriberFailures: { ...storage.subscriberFailures, get: () => Promise.reject(down) },
        };
      },
    };
    const records: OnPersonalDataAccessArgs[] = [];
    const { app } = await createTestApp({
      registry: registryWith(),
      adapter: failing,
      onPersonalDataAccess: (args) => {
        records.push(args);
      },
    });

    await expect(app.deadLetters.list()).rejects.toBe(down);
    await expect(app.subscriberFailures.get("projection:customerDirectory")).rejects.toBe(down);
    expect(
      records.map(({ access }) => [
        access.operation,
        access.persons,
        access.outcome,
        access.errorName,
        access.errorCode,
      ]),
    ).toEqual([
      ["deadLetters.list", [], "refused", "Error", null],
      ["subscriberFailures.get", [], "refused", "Error", null],
    ]);
  });

  it("records a query refused because its read model's database went back as refused, naming no one", async () => {
    const records: PersonalDataAccess[] = [];
    const directory = memory();
    const clock = createFixedClock(new Date(AT));
    const config = {
      storage: memory(),
      readModels: { customerDirectory: directory },
      runtime: { policies: { retry: { strategy: "none" as const } } },
    };
    const worker = await createApp({ registry: registryWith(), config, clock });
    await worker.commands.registerCustomer({
      customerId: "ana",
      email: "ana@example.com",
      plan: "pro",
    });
    await worker.runUntilIdle();
    const web = await createApp({
      registry: registryWith({
        onPersonalDataAccess: ({ access }) => {
          records.push(access);
        },
      }),
      config: { ...config, runtime: { ...config.runtime, role: "web" as const } },
      clock,
    });
    web.start();
    const operator = web.as("operator-1");
    const ask = () =>
      operator.queries.customersOnPlan({ plan: "pro" }, { includeRestricted: "legal-claims" });
    expect(await ask()).toEqual(["ana@example.com"]);

    const checkpoints = (await directory.createStorage()).checkpointStore;
    await checkpoints.set(DIRECTORY, 0);
    await checkpoints.remove(streamMarkOf(DIRECTORY));
    clock.advance(GENERATION_INTERVAL_MS);
    await vi.waitFor(async () => {
      await expect(ask()).rejects.toBeInstanceOf(ReadModelRestoringError);
    });
    expect(records.at(-1)).toEqual({
      operation: "query",
      actor: "operator-1",
      persons: [],
      personCount: 0,
      at: clock.now().toISOString(),
      outcome: "refused",
      errorName: "ReadModelRestoringError",
      errorCode: "READ_MODEL_RESTORING",
      restricted: { basis: "legal-claims", persons: [], personCount: 0 },
      unattributed: false,
      detail: { query: "customersOnPlan", readModel: "customerDirectory" },
    });
    await web.stop();
    await worker.stop();
  });

  it("records a query that takes the driver through client.raw of a read model whose personal fields are all sealed as attributed: the driver reads them as ciphertext", async () => {
    const { app, register, accesses } = await setUp();
    await register("ana");
    await register("bo");
    await app.runUntilIdle();

    expect(await app.queries.customersByDriver()).toBe(2);
    expect(accesses()).toEqual([
      expect.objectContaining({
        operation: "query",
        persons: [],
        personCount: 0,
        outcome: "ok",
        errorName: null,
        errorCode: null,
        restricted: null,
        unattributed: false,
        detail: { query: "customersByDriver", readModel: "customerDirectory" },
      }),
    ]);
  });

  it("records an export that fails after it started reading as failed, with what it read by then", async () => {
    const base = memory();
    const rowsDown = new Error("rows down");
    const failingRows: Adapter = {
      ...base,
      createReadModel: async <Row extends object>(
        args: Parameters<Adapter["createReadModel"]>[0],
      ) => {
        const opened = await base.createReadModel<Row>(args);
        return {
          ...opened,
          table: { ...opened.table, findMany: () => Promise.reject(rowsDown) },
        };
      },
    };
    const records: OnPersonalDataAccessArgs[] = [];
    const { app } = await createTestApp({
      registry: registryWith(),
      config: { readModels: { customerDirectory: failingRows } },
      onPersonalDataAccess: (args) => {
        records.push(args);
      },
    });

    await expect(app.as("operator-1").exportPersonalData("ana")).rejects.toBe(rowsDown);
    await expect(app.exportPersonalData("")).rejects.toThrow(
      "exportPersonalData needs the id of the person",
    );
    const failed = {
      operation: "exportPersonalData",
      actor: "operator-1",
      persons: ["ana"],
      personCount: 1,
      at: AT,
      outcome: "failed",
      errorName: "Error",
      errorCode: null,
      restricted: null,
      detail: {
        exportId: expect.any(String),
        redactions: 0,
        events: 0,
        scheduledCommands: 0,
        deadLetters: 0,
        subscriberFailures: 0,
        answers: 0,
        readModelRows: 0,
        recipients: 0,
        withheld: 0,
        includeWithheld: false,
      },
    };
    expect(records.map(({ access }) => access)).toEqual([
      { ...failed, outcome: "started", errorName: null, errorCode: null },
      failed,
      // Refused before it read: it names no one, since it names no person.
      {
        ...failed,
        actor: null,
        persons: [],
        personCount: 0,
        outcome: "refused",
        errorName: "ValidationError",
        errorCode: "VALIDATION_FAILED",
      },
    ]);
  });

  it("records an export whose header fails to read as failed, having handed nothing out", async () => {
    const base = memory();
    const down = new Error("persons down");
    const failing: Adapter = {
      ...base,
      createStorage: async () => {
        const storage = await base.createStorage();
        return {
          ...storage,
          persons: { ...storage.persons, restrictions: () => Promise.reject(down) },
        };
      },
    };
    const records: OnPersonalDataAccessArgs[] = [];
    const { app } = await createTestApp({
      registry: registryWith(),
      adapter: failing,
      onPersonalDataAccess: (args) => {
        records.push(args);
      },
    });
    await expect(app.streamPersonalData("ana")).rejects.toBe(down);
    expect(records.map(({ access }) => access.persons)).toEqual([["ana"]]);
    expect(records.map(({ access }) => [access.operation, access.outcome, access.detail])).toEqual([
      [
        "exportPersonalData",
        "failed",
        {
          exportId: expect.any(String),
          redactions: 0,
          events: 0,
          scheduledCommands: 0,
          deadLetters: 0,
          subscriberFailures: 0,
          answers: 0,
          readModelRows: 0,
          recipients: 0,
          withheld: 0,
          includeWithheld: false,
        },
      ],
    ]);
  });

  it("refuses a tenant export of another tenant before it reads, recorded as refused", async () => {
    const records: OnPersonalDataAccessArgs[] = [];
    const { app } = await createTestApp({
      registry: registryWith(),
      onPersonalDataAccess: (args) => {
        records.push(args);
      },
    });
    const refusal = await app.exportTenant("acme").then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ValidationError);
    expect(refusal).toMatchObject({
      message: "exportTenant names tenant acme, and the app serves another",
      issues: [{ path: ["tenant"], message: "Expected the tenant the app serves" }],
    });
    expect(records.map(({ access }) => [access.operation, access.outcome, access.persons])).toEqual(
      [["exportTenant", "refused", []]],
    );
  });

  it("records a tenant export whose header fails to read as failed, having handed nothing out", async () => {
    const base = memory();
    const down = new Error("stream down");
    // Down once the app has started, which reads the head too.
    let isDown = false;
    const failing: Adapter = {
      ...base,
      createStorage: async () => {
        const storage = await base.createStorage();
        return {
          ...storage,
          eventStore: {
            ...storage.eventStore,
            lastPosition: () => (isDown ? Promise.reject(down) : storage.eventStore.lastPosition()),
          },
        };
      },
    };
    const records: OnPersonalDataAccessArgs[] = [];
    const { app } = await createTestApp({
      registry: registryWith(),
      adapter: failing,
      onPersonalDataAccess: (args) => {
        records.push(args);
      },
    });
    await app.freezeTenant("default");
    isDown = true;
    await expect(app.as("ops-1").exportTenant("default")).rejects.toBe(down);
    expect(records.map(({ access }) => access)).toEqual([
      expect.objectContaining({
        operation: "exportTenant",
        actor: "ops-1",
        persons: [],
        personCount: 0,
        outcome: "failed",
        errorName: "Error",
        detail: {
          exportId: expect.any(String),
          persons: 0,
          recipients: 0,
          events: 0,
          scheduledCommands: 0,
          deadLetters: 0,
          subscriberFailures: 0,
          answers: 0,
          readModelRows: 0,
          forgetLedgerEntries: 0,
        },
      }),
    ]);
  });

  it("reads an export the person's changes overtook again, as many times as a command is, then gives up", async () => {
    const base = memory();
    let overtake: (() => Promise<unknown>) | null = null;
    const overtaking: Adapter = {
      ...base,
      createStorage: async () => {
        const storage = await base.createStorage();
        return {
          ...storage,
          eventStore: {
            ...storage.eventStore,
            readByPerson: async (args) => {
              if (args.afterPosition === 0) await overtake?.();
              return storage.eventStore.readByPerson(args);
            },
          },
        };
      },
    };
    const records: OnPersonalDataAccessArgs[] = [];
    const { app } = await createTestApp({
      registry: registryWith(),
      adapter: overtaking,
      config: { runtime: { commands: { concurrencyRetries: 1 } } },
      onPersonalDataAccess: (args) => {
        records.push(args);
      },
    });
    const grounds = [...RESTRICTION_GROUNDS];
    // Each reading is overtaken by a restriction on another ground.
    overtake = async () => {
      const ground = grounds.shift();
      if (ground !== undefined) await app.restrict("ana", { ground });
    };
    await expect(app.exportPersonalData("ana")).rejects.toBeInstanceOf(ConcurrencyError);
    expect(
      records
        .filter(({ access }) => access.operation === "exportPersonalData")
        .map(({ access }) => access.outcome),
    ).toEqual(["started", "failed", "started", "failed"]);
  });

  it("records a streamed export as it starts, so one its reader leaves unread is recorded too", async () => {
    const { app, register, accesses } = await setUp();
    await register("ana");
    await app.runUntilIdle();
    const parts = (await app.as("operator-1").streamPersonalData("ana"))[Symbol.asyncIterator]();
    await parts.next();
    await parts.next();
    expect(accesses()).toEqual([
      expect.objectContaining({
        operation: "exportPersonalData",
        actor: "operator-1",
        persons: ["ana"],
        outcome: "started",
        detail: expect.objectContaining({ events: 0, recipients: 0 }),
      }),
    ]);
    await parts.return?.(undefined);
    expect(accesses().map(({ outcome }) => outcome)).toEqual(["started", "cancelled"]);
    expect(accesses()[1]).toMatchObject({ detail: { events: 1 } });
  });

  it("hands nothing out, and reads no record, when its start cannot be recorded", async () => {
    const base = memory();
    const reads: string[] = [];
    const counting: Adapter = {
      ...base,
      createStorage: async () => {
        const storage = await base.createStorage();
        return {
          ...storage,
          eventStore: {
            ...storage.eventStore,
            readByPerson: async (args) => {
              reads.push(args.person);
              return storage.eventStore.readByPerson(args);
            },
          },
        };
      },
    };
    const { app } = await createTestApp({
      registry: registryWith(),
      adapter: counting,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
      onPersonalDataAccess: () => {
        throw new Error("audit sink down");
      },
    });
    await app.commands.registerCustomer({
      customerId: "ana",
      email: "ana@example.com",
      plan: "pro",
    });
    await app.runUntilIdle().catch(() => undefined);
    reads.length = 0;
    await expect(app.streamPersonalData("ana")).rejects.toThrow("audit sink down");
    expect(reads).toEqual([]);
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

  it("fails the call when the hook throws, handing out neither its result nor its error", async () => {
    const { app, register, sink } = await setUp();
    await register("ana");
    await register("bo");
    await app.runUntilIdle();
    const [first, second] = await app.deadLetters.list();
    if (first === undefined || second === undefined) throw new Error("expected two letters");
    sink.failing = true;

    await expect(app.exportPersonalData("ana")).rejects.toThrow("audit sink down");
    await expect(app.queries.customersOnPlan({ plan: "pro" })).rejects.toThrow("audit sink down");
    // Refused, it rejects with what the record threw in place of its own error.
    await expect(app.queries.customersOnPlan({ plan: 1 } as never)).rejects.toThrow(
      "audit sink down",
    );
    await expect(app.deadLetters.list()).rejects.toThrow("audit sink down");
    await expect(app.deadLetters.get(first.id)).rejects.toThrow("audit sink down");
    // Acted on before the record, which says how it went: the retry failed again, the discard
    // went through.
    await expect(app.deadLetters.retry(first.id)).rejects.toThrow("audit sink down");
    await expect(app.deadLetters.discard(second.id)).rejects.toThrow("audit sink down");
    expect(await app.deadLetters.count({ status: "failed" })).toBe(1);
    expect(await app.deadLetters.count({ status: "discarded" })).toBe(1);
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
    expect(records.map(({ access }) => [access.operation, access.outcome])).toEqual([
      ["exportPersonalData", "started"],
      ["exportPersonalData", "ok"],
    ]);
    await app.stop();
  });

  it("hands app/audit.ts the tenant the app serves, DEFAULT_TENANT for one that names none", async () => {
    const tenants: string[] = [];
    for (const tenant of [undefined, DEFAULT_TENANT, "acme"]) {
      const app = await createApp({
        registry: registryWith({
          onPersonalDataAccess: (args) => {
            tenants.push(args.tenant);
          },
        }),
        config: { storage: memory() },
        ...(tenant === undefined ? {} : { tenant }),
      });
      await app.exportPersonalData("ana");
      await app.stop();
    }
    expect(tenants).toEqual([
      DEFAULT_TENANT,
      DEFAULT_TENANT,
      DEFAULT_TENANT,
      DEFAULT_TENANT,
      "acme",
      "acme",
    ]);
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
          outcome: "ok",
          errorName: null,
          errorCode: null,
          restricted: null,
          unattributed: false,
          detail: { query: "customersOnPlan", readModel: "customerDirectory" },
        },
      },
    ]);
  });

  it("refuses an audit module without onHostRejection", async () => {
    const registry = { ...registryWith(), audit: { onPersonalDataAccess: () => {} } } as never;
    await expect(createTestApp({ registry })).rejects.toThrow(
      new ConfigurationError(
        'Invalid registry:\n  audit: missing export "onHostRejection" (expected a function)',
      ),
    );
  });

  it("refuses an audit module without onPersonalDataAccess", async () => {
    await expect(createTestApp({ registry: registryWith({} as never) })).rejects.toThrow(
      new ConfigurationError(
        'Invalid registry:\n  audit: missing export "onPersonalDataAccess" (expected a function)',
      ),
    );
  });
});
