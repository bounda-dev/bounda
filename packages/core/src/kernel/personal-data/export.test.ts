import { describe, expect, it } from "vitest";
import type { Table as RowTable } from "../../adapter/storage/table.ts";
import { pendingEvent, testContext, testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { resolveConfig } from "../../config/schema.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { type AppStorage, appStorage } from "../events/app-event-store.ts";
import { buildReadModels } from "../read-model/build-read-models.ts";
import { sealedTable } from "../read-model/sealed-table.ts";
import { createSealingKeyRing } from "../read-model/sealing-keys.ts";
import type { RecipientsRuntime } from "../recipients/build.ts";
import { keysOver, testWrapping } from "../test-support.ts";
import { sealAnswer } from "./answers.ts";
import { createAtRestSealer } from "./at-rest.ts";
import { buildPersonalCategories } from "./categories.ts";
import { sealCommandPayload } from "./commands.ts";
import { createDisposableKey, seal } from "./crypto.ts";
import { sealError } from "./errors.ts";
import { exportPersonalData, streamPersonalData } from "./export-stream.ts";

const NO_RECIPIENTS: RecipientsRuntime = { all: [], byPort: {}, byOwner: {} };

const unchecked = async (): Promise<void> => undefined;

type Table = RowTable<Record<string, unknown>>;

const DAY = 86_400_000;
const invoices = { category: "invoices" as never };

const registry: Registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.email()), plan: z.string() }),
          evolve: () => ({}),
        },
        customerRenamed: { evolve: () => ({}) },
      },
      commands: {
        remindCustomer: {
          module: {
            payload: ({ z, personal }: CommandPayloadArgs) =>
              z.object({ customerId: z.string(), email: personal(z.email()) }),
            handler: () => [],
          },
        },
      },
      policies: {},
      processes: {},
    },
    order: {
      events: {
        orderPlaced: {
          payload: ({ z, personal, person }: EventPayloadArgs) =>
            z.object({
              customerId: person(z.string()),
              note: personal(z.string(), invoices).optional(),
              total: z.number(),
            }),
          evolve: () => ({}),
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {
    customerDirectory: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().personal(),
          plan: f.string(),
        }),
      },
      projections: { bounda: { personalDataForgotten: { project: () => undefined } } },
      queries: {},
    },
    orderNotes: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey(),
          customerId: f.string().person(),
          note: f.string().personal(invoices).optional(),
          total: f.number(),
        }),
      },
      projections: { bounda: { personalDataForgotten: { project: () => undefined } } },
      queries: {},
    },
    // Only an id, with no field marked personal: its rows are theirs to know about.
    orderCustomers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey(),
          customerId: f.string().person(),
        }),
      },
      projections: {},
      queries: {},
    },
    // No field marked: not in the export.
    orderTotals: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey(),
          customerId: f.string(),
          total: f.number(),
        }),
      },
      projections: {},
      queries: {},
    },
  },
  personalData: {
    automatedDecisions: {},
    categories: {
      invoices: {
        basis: "legal-obligation",
        retention: "60d",
        purposes: ["Serve the person"],
        sources: ["data-subject"],
      },
    },
  },
};

const categories = buildPersonalCategories({
  module: registry.personalData,
  retention: { months: 0, ms: 30 * DAY },
});

const exportedCategories = {
  default: {
    basis: null,
    special: null,
    criminal: null,
    purposes: [],
    processedFor: [],
    erasureExemptions: [],
    sources: [],
    retention: "30d",
    held: true,
    keptUntil: null,
    restrictedUntil: null,
  },
  invoices: {
    basis: "legal-obligation",
    special: null,
    criminal: null,
    purposes: ["Serve the person"],
    processedFor: [],
    erasureExemptions: [{ exemption: "legal-obligation", article: "17(3)(b)" }],
    sources: ["data-subject"],
    retention: "60d",
    held: true,
    keptUntil: null,
    restrictedUntil: null,
  },
};

const exportedRights = [
  { right: "access", article: "15", categories: null },
  { right: "rectification", article: "16", categories: null },
  { right: "erasure", article: "17", categories: ["default"] },
  { right: "restriction", article: "18", categories: null },
  { right: "objection", article: "21(1)", categories: [] },
  { right: "complaint", article: "77", categories: null },
];

const setup = async () => {
  const aggregates = buildAggregates({ registry, ports: {} });
  // A read model of its own adapter, as `readModels` in the configuration may give it.
  const readModels = await buildReadModels({
    registry,
    config: resolveConfig({ storage: memory(), readModels: { orderNotes: memory() } }),
    logger: silentLogger,
  });
  const written = await memory().createStorage();
  const storage: AppStorage = appStorage({
    storage: written,
    aggregates,
    processes: { byName: {} },
    wrapping: testWrapping(),
  });
  // Written as a projection writes, sealed under the keys the persons hold.
  const table = (name: string) => {
    const readModel = readModels.byName[name];
    if (readModel === undefined) throw new Error(`no read model ${name}`);
    return sealedTable({
      context: {
        layout: readModel.layout,
        keys: createSealingKeyRing({ keys: storage.personalKeys, fetching: true }),
        indexer: null,
        event: () => null,
      },
      table: readModel.storage.table,
    });
  };
  const exportOf = (personId: string, batchSize = 2, includeWithheld = false) =>
    exportPersonalData({
      storage,
      aggregates,
      processes: { byName: {} },
      readModels,
      sealing: { keys: storage.personalKeys, indexer: null, redactions: async () => [] },
      clock: createFixedClock(),
      batchSize,
      categories,
      recipients: NO_RECIPIENTS,
      transfers: [],
      personId,
      includeWithheld,
      onPage: unchecked,
    });
  const streamOf = (personId: string, includeWithheld: boolean) =>
    streamPersonalData({
      storage,
      aggregates,
      processes: { byName: {} },
      readModels,
      sealing: { keys: storage.personalKeys, indexer: null, redactions: async () => [] },
      clock: createFixedClock(),
      batchSize: 2,
      categories,
      recipients: NO_RECIPIENTS,
      transfers: [],
      personId,
      includeWithheld,
      onPage: unchecked,
    });
  const register = (aggregateId: string, email: string) =>
    storage.eventStore.append({
      aggregateType: "customer",
      aggregateId,
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "customer",
          aggregateId,
          version: 1,
          type: "CustomerRegistered",
          payload: { email, plan: "pro" },
        }),
      ],
    });
  const place = (aggregateId: string, payload: object) =>
    storage.eventStore.append({
      aggregateType: "order",
      aggregateId,
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "order",
          aggregateId,
          version: 1,
          type: "OrderPlaced",
          payload,
        }),
      ],
    });
  const sealedReminder = (customerId: string, email: string) =>
    sealCommandPayload({
      type: "RemindCustomer",
      aggregateId: customerId,
      payload: { customerId, email },
      marks: aggregates.commandsByType.RemindCustomer?.command.personal ?? null,
      keys: keysOver(storage.personalKeys),
    });
  // An error whose message quotes the person, as a handler's may.
  const failure = (person: string | null, message: string) => {
    const error = new Error(message);
    error.stack = `Error: ${message}\n    at handler`;
    return sealError({ error, person, keys: keysOver(storage.personalKeys) });
  };
  return {
    storage,
    written,
    exportOf,
    streamOf,
    register,
    place,
    sealedReminder,
    failure,
    table,
    aggregates,
    readModels,
  };
};

describe("exportPersonalData", () => {
  it("refuses an empty id, and reads nothing for it", async () => {
    const { exportOf } = await setup();
    await expect(exportOf("")).rejects.toThrow(
      new ValidationError("exportPersonalData needs the id of the person", [
        { path: ["personId"], message: "Expected a non-empty string" },
      ]),
    );
    await expect(exportOf(undefined as unknown as string)).rejects.toBeInstanceOf(ValidationError);
  });

  it("gathers the person's events page by page, with their marked fields opened and nothing else", async () => {
    const { exportOf, register, place, storage } = await setup();
    await register("c-1", "ana@example.com");
    await place("o-1", { customerId: "c-1", note: "ring twice", total: 10 });
    await register("c-2", "bo@example.com");
    await place("o-2", { customerId: "c-1", total: 20 });
    await storage.eventStore.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 1,
      events: [
        pendingEvent({
          aggregateType: "customer",
          aggregateId: "c-1",
          version: 2,
          type: "CustomerRenamed",
          payload: { name: "Ana" },
        }),
      ],
    });
    await place("o-3", { customerId: "c-1", note: "leave at door", total: 30 });
    // An event of a type the aggregate no longer defines, stored while it did.
    await storage.eventStore.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 2,
      events: [
        pendingEvent({
          aggregateType: "customer",
          aggregateId: "c-1",
          version: 3,
          type: "CustomerMoved",
          payload: { street: "x" },
          person: "c-1",
        }),
      ],
    });

    const exported = await exportOf("c-1");
    expect(exported).toStrictEqual({
      personId: "c-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      position: 7,
      categories: exportedCategories,
      rights: exportedRights,
      automatedDecisions: [],
      restrictions: [],
      redactions: [],
      recipients: [],
      transfers: [],
      events: [
        {
          id: "customer-c-1-1",
          type: "CustomerRegistered",
          aggregateType: "customer",
          aggregateId: "c-1",
          version: 1,
          position: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { email: "ana@example.com" },
          categories: { email: "default" },
          restricted: [],
          redacted: [],
        },
        {
          id: "order-o-1-1",
          type: "OrderPlaced",
          aggregateType: "order",
          aggregateId: "o-1",
          version: 1,
          position: 2,
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { note: "ring twice" },
          categories: { note: "invoices" },
          restricted: [],
          redacted: [],
        },
        {
          id: "order-o-2-1",
          type: "OrderPlaced",
          aggregateType: "order",
          aggregateId: "o-2",
          version: 1,
          position: 4,
          timestamp: "2026-01-01T00:00:00.000Z",
          data: {},
          categories: {},
          restricted: [],
          redacted: [],
        },
        {
          id: "order-o-3-1",
          type: "OrderPlaced",
          aggregateType: "order",
          aggregateId: "o-3",
          version: 1,
          position: 6,
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { note: "leave at door" },
          categories: { note: "invoices" },
          restricted: [],
          redacted: [],
        },
        {
          id: "customer-c-1-3",
          type: "CustomerMoved",
          aggregateType: "customer",
          aggregateId: "c-1",
          version: 3,
          position: 7,
          timestamp: "2026-01-01T00:00:00.000Z",
          data: {},
          categories: {},
          restricted: [],
          redacted: [],
        },
      ],
      scheduledCommands: [],
      deadLetters: [],
      subscriberFailures: [],
      answers: [],
      readModels: { customerDirectory: [], orderNotes: [], orderCustomers: [] },
    });
    expect(await exportOf("c-1", 100)).toEqual(exported);
    // One row a page: the person field that is the directory's key stays the person's.
    expect(await exportOf("c-1", 1)).toEqual(exported);
    expect((await exportOf("c-2")).events.map((event) => event.data)).toEqual([
      { email: "bo@example.com" },
    ]);
    expect((await exportOf("c-3")).events).toEqual([]);
  });

  it("holds no data of a lifecycle event of a process the app no longer has", async () => {
    const { exportOf, written } = await setup();
    await written.eventStore.append({
      aggregateType: "process:customer.gone",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "process:customer.gone",
          aggregateId: "c-1",
          version: 1,
          type: "ProcessHandled",
          payload: { state: { email: null } },
          person: "c-1",
        }),
      ],
    });
    expect((await exportOf("c-1")).events.map((event) => [event.type, event.data])).toEqual([
      ["ProcessHandled", {}],
    ]);
  });

  it("includes the scheduled commands and dead letters that hold the person's fields, opened", async () => {
    const { exportOf, storage, sealedReminder, failure } = await setup();
    const ana = await sealedReminder("c-1", "ana@example.com");
    const bo = await sealedReminder("c-2", "bo@example.com");
    await storage.scheduler.schedule({
      dedupeKey: "command:cmd-1",
      command: { type: "RemindCustomer", aggregateId: "c-1", payload: ana.payload },
      executeAt: new Date("2026-01-02T00:00:00.000Z"),
      scheduledAt: new Date("2026-01-02T00:00:00.000Z"),
      context: testContext,
      persons: ana.persons,
    });
    // Stored before Bounda recorded when a command was scheduled.
    await storage.scheduler.schedule({
      dedupeKey: "command:cmd-0",
      command: { type: "RemindCustomer", aggregateId: "c-1", payload: ana.payload },
      executeAt: new Date("2026-01-03T00:00:00.000Z"),
      scheduledAt: new Date("2026-01-03T00:00:00.000Z"),
      context: testContext,
      persons: ana.persons,
    });
    const listByPerson = storage.scheduler.listByPerson;
    Object.assign(storage.scheduler, {
      listByPerson: async (args: Parameters<typeof listByPerson>[0]) =>
        (await listByPerson(args)).map(({ scheduledAt, ...entry }) =>
          entry.dedupeKey === "command:cmd-0" ? entry : { ...entry, scheduledAt },
        ),
    });
    await storage.scheduler.schedule({
      dedupeKey: "command:cmd-2",
      command: { type: "RemindCustomer", aggregateId: "c-2", payload: bo.payload },
      executeAt: new Date("2026-01-02T00:00:00.000Z"),
      scheduledAt: new Date("2026-01-02T00:00:00.000Z"),
      context: testContext,
      persons: bo.persons,
    });
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-1"),
      ...(await failure("c-1", "no mailbox for ana@example.com")),
      kind: "scheduled",
      handler: "RemindCustomer",
      eventType: "RemindCustomer",
      person: "c-1",
      payload: ana.payload,
      persons: ana.persons,
    });
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-2"),
      ...(await failure("c-2", "no mailbox for bo@example.com")),
      person: "c-2",
    });
    // A command the registry no longer has: its payload is opened, and no field is marked. Its
    // error is sealed under someone else, so it is not theirs to take away.
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-3"),
      ...(await failure("c-2", "bo@example.com was busy")),
      kind: "scheduled",
      handler: "NudgeCustomer",
      eventType: "NudgeCustomer",
      firstFailedAt: "2026-01-01T00:01:00.000Z",
      person: "c-2",
      payload: ana.payload,
      persons: ana.persons,
    });
    // A policy's run about them, whose error quotes what it read.
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-4"),
      ...(await failure("c-1", "ana@example.com bounced")),
      firstFailedAt: "2026-01-01T00:02:00.000Z",
      person: "c-1",
    });

    const exported = await exportOf("c-1");
    expect(exported.scheduledCommands).toStrictEqual([
      {
        commandId: "cmd-0",
        type: "RemindCustomer",
        executeAt: "2026-01-03T00:00:00.000Z",
        data: { email: "ana@example.com" },
        categories: { email: "default" },
        restricted: [],
      },
      {
        commandId: "cmd-1",
        type: "RemindCustomer",
        executeAt: "2026-01-02T00:00:00.000Z",
        scheduledAt: "2026-01-02T00:00:00.000Z",
        data: { email: "ana@example.com" },
        categories: { email: "default" },
        restricted: [],
      },
    ]);
    expect(exported.deadLetters).toStrictEqual([
      {
        id: "dl-1",
        kind: "scheduled",
        handler: "RemindCustomer",
        errorMessage: "no mailbox for ana@example.com",
        errorStack: "Error: no mailbox for ana@example.com\n    at handler",
        data: { email: "ana@example.com" },
        categories: { email: "default" },
        restricted: [],
        withheld: [],
      },
      {
        id: "dl-3",
        kind: "scheduled",
        handler: "NudgeCustomer",
        data: {},
        categories: {},
        restricted: [],
        withheld: [],
      },
      {
        id: "dl-4",
        kind: "policy",
        handler: "order.p",
        errorMessage: "ana@example.com bounced",
        errorStack: "Error: ana@example.com bounced\n    at handler",
        data: {},
        categories: {},
        restricted: [],
        withheld: [],
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain("bo@example.com");

    // Restricted, the same records come out, saying what of them the restriction covers.
    await storage.persons.restrict("c-1", {
      ground: "objection-pending",
      categories: ["default"],
      since: new Date("2026-01-03T00:00:00.000Z"),
    });
    const restricted = await exportOf("c-1");
    expect(restricted.restrictions).toEqual([
      { ground: "objection-pending", categories: ["default"], since: "2026-01-03T00:00:00.000Z" },
    ]);
    expect(restricted.scheduledCommands[0]?.restricted).toEqual(["email"]);
    expect(restricted.deadLetters.map(({ id, restricted: covered }) => [id, covered])).toEqual([
      ["dl-1", ["email", "errorMessage", "errorStack"]],
      ["dl-3", []],
      ["dl-4", ["errorMessage", "errorStack"]],
    ]);
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-5"),
      ...(await failure("c-1", "no stack")),
      errorStack: undefined,
      firstFailedAt: "2026-01-01T00:03:00.000Z",
      person: "c-1",
    } as never);
    expect((await exportOf("c-1")).deadLetters.at(-1)?.restricted).toEqual(["errorMessage"]);
  });

  it("hands the person the last failures about them, marking their text while a restriction holds", async () => {
    const { exportOf, storage, failure } = await setup();
    const sealed = await failure("c-1", "cannot index ana@example.com");
    for (const [subscriber, withStack] of [
      ["projection:a", true],
      ["projection:b", false],
    ] as const) {
      await storage.subscriberFailures.record({
        subscriber,
        position: 1,
        eventId: `e-${subscriber}`,
        eventType: "CustomerRegistered",
        person: "c-1",
        errorName: "Error",
        errorMessage: sealed.errorMessage,
        ...(withStack ? { errorStack: sealed.errorStack } : {}),
        failedAt: "2026-01-01T00:00:00.000Z",
      } as never);
    }
    expect((await exportOf("c-1")).subscriberFailures.map(({ restricted }) => restricted)).toEqual([
      [],
      [],
    ]);
    await storage.persons.restrict("c-1", {
      ground: "accuracy-contested",
      categories: null,
      since: new Date("2026-01-03T00:00:00.000Z"),
    });
    const exported = await exportOf("c-1");
    expect(exported.subscriberFailures).toEqual([
      expect.objectContaining({
        subscriber: "projection:a",
        restricted: ["errorMessage", "errorStack"],
      }),
      expect.objectContaining({ subscriber: "projection:b", restricted: ["errorMessage"] }),
    ]);
  });

  it("includes the rows of every read model with a person field, page by page, with their key and marked fields only, opened", async () => {
    const { exportOf, table, storage } = await setup();
    for (const person of ["c-1", "c-2"]) {
      for (const category of ["default", "invoices"]) {
        await storage.personalKeys.create(person, category);
      }
    }
    await table("customerDirectory").insert({
      customerId: "c-1",
      email: "ana@example.com",
      plan: "pro",
    });
    await table("customerDirectory").insert({
      customerId: "c-2",
      email: "bo@example.com",
      plan: "free",
    });
    for (const [orderId, customerId, note] of [
      ["o-3", "c-1", "leave at door"],
      ["o-1", "c-1", "ring twice"],
      ["o-2", "c-2", "bo's"],
      ["o-4", "c-1", undefined],
    ] as const) {
      await table("orderNotes").insert({
        orderId,
        customerId,
        total: 10,
        ...(note === undefined ? {} : { note }),
      });
      await table("orderCustomers").insert({ orderId, customerId });
      await table("orderTotals").insert({ orderId, customerId, total: 10 });
    }

    const exported = await exportOf("c-1");
    expect(exported.readModels).toStrictEqual({
      customerDirectory: [
        {
          key: "c-1",
          data: { email: "ana@example.com" },
          categories: { email: "default" },
          restricted: [],
        },
      ],
      orderNotes: [
        {
          key: "o-1",
          data: { note: "ring twice" },
          categories: { note: "invoices" },
          restricted: [],
        },
        {
          key: "o-3",
          data: { note: "leave at door" },
          categories: { note: "invoices" },
          restricted: [],
        },
        { key: "o-4", data: {}, categories: {}, restricted: [] },
      ],
      orderCustomers: [
        { key: "o-1", data: {}, categories: {}, restricted: [] },
        { key: "o-3", data: {}, categories: {}, restricted: [] },
        { key: "o-4", data: {}, categories: {}, restricted: [] },
      ],
    });
    expect(await exportOf("c-1", 100)).toEqual(exported);
    // One row a page: the person field that is the directory's key stays the person's.
    expect(await exportOf("c-1", 1)).toEqual(exported);
    expect(JSON.stringify(exported)).not.toContain('"bo');
    expect(JSON.stringify(exported)).not.toContain('"pro"');
  });

  it.each([
    ["deletes", (notes: Table) => notes.delete({ orderId: "o-2" })],
    [
      "inserts",
      (notes: Table) => notes.insert({ orderId: "o-1", customerId: "c-1", total: 10, note: "o-1" }),
    ],
  ])(
    "pages rows by key, so a row a projection %s between pages makes none skip or repeat",
    async (_, write) => {
      const { storage, aggregates, readModels, table } = await setup();
      for (const orderId of ["o-2", "o-4", "o-6", "o-8"]) {
        await table("orderNotes").insert({ orderId, customerId: "c-1", total: 10, note: orderId });
      }
      const notes = readModels.byName.orderNotes;
      if (notes === undefined) throw new Error("no read model orderNotes");
      let pages = 0;
      const writing = {
        ...notes,
        storage: {
          ...notes.storage,
          table: {
            ...notes.storage.table,
            findMany: async (args?: Parameters<Table["findMany"]>[0]) => {
              const page = await notes.storage.table.findMany(args);
              if (pages++ === 0) await write(notes.storage.table);
              return page;
            },
          },
        },
      };
      const exported = await exportPersonalData({
        storage,
        aggregates,
        processes: { byName: {} },
        readModels: { ...readModels, byName: { ...readModels.byName, orderNotes: writing } },
        sealing: { keys: storage.personalKeys, indexer: null, redactions: async () => [] },
        clock: createFixedClock(),
        batchSize: 3,
        categories,
        recipients: NO_RECIPIENTS,
        transfers: [],
        personId: "c-1",
        includeWithheld: false,
        onPage: unchecked,
      });
      expect(exported.readModels.orderNotes?.map((row) => row.key)).toEqual([
        "o-2",
        "o-4",
        "o-6",
        "o-8",
      ]);
      expect(pages).toBe(2);
    },
  );

  it("rejects with the store's failure when the read models fail too, leaving none unhandled", async () => {
    const { storage, aggregates, readModels } = await setup();
    const down = new Error("store down");
    const failing = Object.fromEntries(
      Object.entries(readModels.byName).map(([name, readModel]) => [
        name,
        {
          ...readModel,
          storage: {
            ...readModel.storage,
            table: {
              ...readModel.storage.table,
              findMany: () => Promise.reject(new Error("rows down")),
            },
          },
        },
      ]),
    );
    await expect(
      exportPersonalData({
        storage: {
          ...storage,
          eventStore: { ...storage.eventStore, readByPerson: () => Promise.reject(down) },
        },
        aggregates,
        processes: { byName: {} },
        readModels: { ...readModels, byName: failing },
        sealing: { keys: storage.personalKeys, indexer: null, redactions: async () => [] },
        clock: createFixedClock(),
        batchSize: 2,
        categories,
        recipients: NO_RECIPIENTS,
        transfers: [],
        personId: "c-1",
        includeWithheld: false,
        onPage: unchecked,
      }),
    ).rejects.toBe(down);
  });

  it("reads a forgotten person's fields and error text as null", async () => {
    const { exportOf, register, storage, sealedReminder, failure } = await setup();
    await register("c-1", "ana@example.com");
    const ana = await sealedReminder("c-1", "ana@example.com");
    await storage.scheduler.schedule({
      dedupeKey: "deadline:x",
      command: { type: "RemindCustomer", aggregateId: "c-1", payload: ana.payload },
      executeAt: new Date("2026-01-02T00:00:00.000Z"),
      scheduledAt: new Date("2026-01-02T00:00:00.000Z"),
      context: testContext,
      persons: ana.persons,
    });
    const { errorStack: _stack, ...withoutStack } = await failure("c-1", "ana@example.com bounced");
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-1"),
      ...withoutStack,
      person: "c-1",
    });
    for (const { key } of await storage.personalKeys.list("c-1")) {
      await storage.personalKeys.remove("c-1", key.fingerprint);
    }
    const exported = await exportOf("c-1");
    expect(exported.events.map((event) => event.data)).toEqual([{ email: null }]);
    expect(exported.deadLetters).toStrictEqual([
      {
        id: "dl-1",
        kind: "policy",
        handler: "order.p",
        errorMessage: null,
        data: {},
        categories: {},
        restricted: [],
        withheld: [],
      },
    ]);
    expect(exported.scheduledCommands).toEqual([
      {
        commandId: "deadline:x",
        type: "RemindCustomer",
        executeAt: "2026-01-02T00:00:00.000Z",
        scheduledAt: "2026-01-02T00:00:00.000Z",
        data: { email: null },
        categories: { email: "default" },
        restricted: [],
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain("ana@example.com");
  });

  it("tells until when what a forgetting kept of a category under a legal obligation stays restricted", async () => {
    const { exportOf, place, register, storage } = await setup();
    await register("c-1", "ana@example.com");
    await place("o-1", { customerId: "c-1", note: "ring twice", total: 10 });
    // Their keys in force know their last activity, which keeps nothing restricted.
    await storage.personalKeys.touch("c-1", "2026-01-08T00:00:00.000Z");
    const invoiceKey = async () =>
      (await storage.personalKeys.list("c-1")).find(
        ({ category, retainedSince }) => category === "invoices" && retainedSince === null,
      )?.key.fingerprint ?? "";
    await storage.personalKeys.retain("c-1", await invoiceKey(), {
      since: "2026-01-10T00:00:00.000Z",
      lastActiveAt: "2026-01-05T00:00:00.000Z",
    });
    const kept = await exportOf("c-1");
    expect(kept.categories).toEqual({
      ...exportedCategories,
      invoices: { ...exportedCategories.invoices, restrictedUntil: "2026-03-06T00:00:00.000Z" },
    });
    expect(
      kept.events.map(({ data, categories, restricted }) => [data, categories, restricted]),
    ).toEqual([
      [{ email: "ana@example.com" }, { email: "default" }, []],
      [{ note: "ring twice" }, { note: "invoices" }, ["note"]],
    ]);
    // They came back, and what they wrote since is not what the law kept; kept again later, the
    // latest end is when nothing kept is left.
    await place("o-2", { customerId: "c-1", note: "back again", total: 20 });
    const back = await exportOf("c-1");
    expect(back.events.map(({ data, restricted }) => [data, restricted])).toEqual([
      [{ email: "ana@example.com" }, []],
      [{ note: "ring twice" }, ["note"]],
      [{ note: "back again" }, []],
    ]);
    await storage.personalKeys.retain("c-1", await invoiceKey(), {
      since: "2026-01-20T00:00:00.000Z",
      lastActiveAt: "2026-01-15T00:00:00.000Z",
    });
    expect((await exportOf("c-1")).categories.invoices?.restrictedUntil).toBe(
      "2026-03-16T00:00:00.000Z",
    );
  });

  it("keeps nothing restricted for a category kept without a retention", async () => {
    const { storage, aggregates, readModels, register } = await setup();
    await register("c-1", "ana@example.com");
    const [key] = await storage.personalKeys.list("c-1");
    await storage.personalKeys.retain("c-1", key?.key.fingerprint ?? "", {
      since: "2026-01-10T00:00:00.000Z",
      lastActiveAt: "2026-01-05T00:00:00.000Z",
    });
    const exported = await exportPersonalData({
      storage,
      aggregates,
      readModels,
      sealing: { keys: storage.personalKeys, indexer: null, redactions: async () => [] },
      processes: { byName: {} },
      clock: createFixedClock(),
      batchSize: 2,
      categories: buildPersonalCategories({ module: undefined, retention: null }),
      recipients: NO_RECIPIENTS,
      transfers: [],
      personId: "c-1",
      includeWithheld: false,
      onPage: unchecked,
    });
    expect(exported.categories.default?.restrictedUntil).toBeNull();
  });

  it("names the default category without a basis, and without a retention when the app sets none", async () => {
    const { exportOf, storage, aggregates, readModels } = await setup();
    const exported = await exportPersonalData({
      storage,
      aggregates,
      readModels,
      sealing: { keys: storage.personalKeys, indexer: null, redactions: async () => [] },
      processes: { byName: {} },
      clock: createFixedClock(),
      batchSize: 2,
      categories: buildPersonalCategories({ module: undefined, retention: null }),
      recipients: NO_RECIPIENTS,
      transfers: [],
      personId: "c-1",
      includeWithheld: false,
      onPage: unchecked,
    });
    const none = { held: false, keptUntil: null, restrictedUntil: null };
    expect(exported.categories).toEqual({
      default: {
        basis: null,
        special: null,
        criminal: null,
        purposes: [],
        processedFor: [],
        erasureExemptions: [],
        sources: [],
        retention: null,
        ...none,
      },
    });
    expect((await exportOf("c-1")).categories).toEqual({
      default: { ...exportedCategories.default, ...none },
      invoices: { ...exportedCategories.invoices, ...none },
    });
  });

  it("hands out each answer remembered of the person that still opens, in the order the store files them", async () => {
    const { storage, exportOf } = await setup();
    const keys = storage.personalKeys;
    const own = await keys.create("c-1", "default");
    const outcome = {
      rejected: "Taken",
      message: "ana@example.com is taken",
      aggregateType: "customer",
      aggregateId: "c-1",
    };
    const now = new Date("2026-01-01T00:00:00.000Z");
    const remember = async (filed: string, key: string) => {
      const sealed = await sealAnswer({
        keys,
        atRest: createAtRestSealer(
          await crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveKey"]),
        ),
        answer: { key, fingerprint: "fp", outcome },
        person: "c-1",
        marks: null,
        payload: {},
        read: [],
      });
      await storage.idempotencyStore.put({
        key: filed,
        answer: sealed.answer,
        persons: sealed.persons,
        expiresAt: "2026-01-02T00:00:00.000Z",
        now,
      });
    };
    // Filed in another order than their keys sort in, as an HMAC files them: the export keeps the
    // store's.
    await remember("h-1", "confirm-3");
    await remember("h-3", "confirm-1");
    const sealedAnswer = (await storage.idempotencyStore.get({ key: "h-1", now }))?.answer ?? null;
    // Sealed under a key the person no longer holds: nothing of it opens.
    await storage.idempotencyStore.put({
      key: "h-2",
      answer: await seal({
        key: await createDisposableKey(),
        person: "c-1",
        category: "default",
        value: { key: "confirm-2", fingerprint: "fp", outcome },
      }),
      persons: [{ person: "c-1", fingerprint: own.fingerprint }],
      expiresAt: "2026-01-02T00:00:00.000Z",
      now,
    });
    // Erased with a forgetting, the key alone kept taken.
    await storage.idempotencyStore.put({
      key: "h-0",
      answer: sealedAnswer,
      persons: [{ person: "c-1", fingerprint: "forgotten" }],
      expiresAt: "2026-01-02T00:00:00.000Z",
      now,
    });
    expect((await storage.idempotencyStore.get({ key: "h-0", now }))?.answer).toBeNull();
    expect((await exportOf("c-1")).answers).toEqual([
      {
        idempotencyKey: "confirm-3",
        expiresAt: "2026-01-02T00:00:00.000Z",
        outcome,
        restricted: [],
        withheld: [],
      },
      {
        idempotencyKey: "confirm-1",
        expiresAt: "2026-01-02T00:00:00.000Z",
        outcome,
        restricted: [],
        withheld: [],
      },
    ]);
    expect((await exportOf("c-2")).answers).toEqual([]);
  });

  it("holds back from each person the text sealed under someone else too, and says so, unless asked to open it", async () => {
    const { exportOf, streamOf, storage, register } = await setup();
    await register("c-1", "ana@example.com");
    await register("c-2", "bea@example.com");
    const keys = keysOver(storage.personalKeys);
    const [bea] = await storage.personalKeys.list("c-2");
    const readBea = [{ person: "c-2", fingerprint: bea?.key.fingerprint ?? null }];
    const text = (message: string, args: Omit<Parameters<typeof sealError>[0], "error" | "keys">) =>
      sealError({ error: new Error(message), keys, ...args });
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-1"),
      ...(await text("ana alone", { person: "c-1" })),
      person: "c-1",
    });
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-2"),
      ...(await text("ana's courier bea", { person: "c-1", statePerson: "c-2" })),
      kind: "process",
      person: "c-1",
      statePerson: "c-2",
    });
    const read = await text("ana owes bea@example.com", { person: "c-1", read: readBea });
    expect(read.readPersons).toEqual(["c-2"]);
    await storage.deadLetterStore.add({ ...testDeadLetter("dl-3"), ...read, person: "c-1" });
    const { errorStack: _stack, ...stackless } = await text("no stack", {
      person: "c-1",
      read: readBea,
    });
    await storage.deadLetterStore.add({ ...testDeadLetter("dl-4"), ...stackless, person: "c-1" });
    const failed = await text("cannot index bea@example.com", { person: "c-1", read: readBea });
    await storage.subscriberFailures.record({
      subscriber: "projection:a",
      position: 1,
      eventId: "e-1",
      eventType: "CustomerRegistered",
      person: "c-1",
      ...failed,
      failedAt: "2026-01-01T00:00:00.000Z",
    });
    const outcome = {
      rejected: "Owed",
      message: "bea@example.com is owed",
      aggregateType: "customer",
      aggregateId: "c-2",
    };
    const now = new Date("2026-01-01T00:00:00.000Z");
    const sealed = await sealAnswer({
      keys,
      atRest: createAtRestSealer(
        await crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveKey"]),
      ),
      answer: { key: "pay-bea", fingerprint: "fp", outcome },
      person: "c-1",
      marks: null,
      payload: {},
      read: readBea,
    });
    await storage.idempotencyStore.put({
      key: "h-1",
      ...sealed,
      expiresAt: "2026-01-02T00:00:00.000Z",
      now,
    });

    const forOthers = (...fields: string[]) =>
      fields.map((field) => ({ field, reason: "rights-of-others", article: "15(4)" }));
    const letters = (exported: Awaited<ReturnType<typeof exportOf>>) =>
      exported.deadLetters.map(({ id, errorMessage, errorStack, withheld }) => ({
        id,
        errorMessage,
        errorStack,
        withheld,
      }));
    for (const person of ["c-1", "c-2"]) {
      const exported = await exportOf(person);
      expect(letters(exported)).toEqual([
        ...(person === "c-1"
          ? [
              {
                id: "dl-1",
                errorMessage: "ana alone",
                errorStack: expect.stringContaining("ana alone"),
                withheld: [],
              },
            ]
          : []),
        {
          id: "dl-2",
          errorMessage: null,
          errorStack: null,
          withheld: forOthers("errorMessage", "errorStack"),
        },
        {
          id: "dl-3",
          errorMessage: null,
          errorStack: null,
          withheld: forOthers("errorMessage", "errorStack"),
        },
        {
          id: "dl-4",
          errorMessage: null,
          errorStack: undefined,
          withheld: forOthers("errorMessage"),
        },
      ]);
      expect(exported.subscriberFailures).toEqual([
        {
          subscriber: "projection:a",
          eventId: "e-1",
          eventType: "CustomerRegistered",
          errorMessage: null,
          errorStack: null,
          restricted: [],
          withheld: forOthers("errorMessage", "errorStack"),
        },
      ]);
      expect(exported.answers).toEqual([
        {
          idempotencyKey: null,
          expiresAt: "2026-01-02T00:00:00.000Z",
          outcome: null,
          restricted: [],
          withheld: forOthers("idempotencyKey", "outcome"),
        },
      ]);
      const json = JSON.stringify(exported);
      expect(json).not.toContain("owes");
      expect(json).not.toContain("is owed");
      expect(json).not.toContain("pay-bea");
      expect(json).not.toContain("courier");
    }

    const opened = await exportOf("c-1", 2, true);
    expect(letters(opened).find(({ id }) => id === "dl-3")).toEqual({
      id: "dl-3",
      errorMessage: "ana owes bea@example.com",
      errorStack: expect.stringContaining("ana owes"),
      withheld: forOthers("errorMessage", "errorStack"),
    });
    expect(opened.subscriberFailures[0]).toMatchObject({
      errorMessage: "cannot index bea@example.com",
      withheld: forOthers("errorMessage", "errorStack"),
    });
    expect(opened.answers[0]).toMatchObject({
      idempotencyKey: "pay-bea",
      outcome,
      withheld: forOthers("idempotencyKey", "outcome"),
    });
    const streamed = await streamOf("c-1", true);
    expect(streamed.others()).toEqual([]);
    for await (const _ of streamed.records);
    expect(streamed.others()).toEqual(["c-2"]);
    const withholding = await streamOf("c-1", false);
    for await (const _ of withholding.records);
    expect(withholding.others()).toEqual([]);

    expect(letters(opened).map(({ id }) => id)).toEqual(["dl-1", "dl-2", "dl-3", "dl-4"]);
    expect(opened.deadLetters.map(({ restricted }) => restricted)).toEqual([[], [], [], []]);
    expect(opened.answers[0]?.restricted).toEqual([]);

    // Opened while the other person is restricted, it says so; held back, nothing of it is.
    await storage.persons.restrict("c-2", {
      ground: "accuracy-contested",
      categories: null,
      since: new Date("2026-01-03T00:00:00.000Z"),
    });
    const restricted = await exportOf("c-1", 2, true);
    expect(restricted.deadLetters.map(({ id, restricted: covered }) => [id, covered])).toEqual([
      ["dl-1", []],
      ["dl-2", ["errorMessage", "errorStack"]],
      ["dl-3", ["errorMessage", "errorStack"]],
      ["dl-4", ["errorMessage"]],
    ]);
    expect(restricted.subscriberFailures[0]?.restricted).toEqual(["errorMessage", "errorStack"]);
    expect(restricted.answers[0]?.restricted).toEqual(["idempotencyKey", "outcome"]);
    const held = await exportOf("c-1");
    expect(held.deadLetters.map(({ restricted: covered }) => covered)).toEqual([[], [], [], []]);
    expect(held.answers[0]?.restricted).toEqual([]);
    await storage.persons.restrict("c-1", {
      ground: "accuracy-contested",
      categories: null,
      since: new Date("2026-01-03T00:00:00.000Z"),
    });
    expect((await exportOf("c-1", 2, true)).answers[0]?.restricted).toEqual([
      "outcome",
      "idempotencyKey",
    ]);
    expect((await exportOf("c-1", 2, true)).deadLetters[2]?.restricted).toEqual([
      "errorMessage",
      "errorStack",
    ]);

    // Once anyone it is sealed under is forgotten, nothing of it opens, and nothing is held back.
    for (const { key } of await storage.personalKeys.list("c-2")) {
      await storage.personalKeys.remove("c-2", key.fingerprint);
    }
    const gone = await exportOf("c-1", 2, true);
    expect(letters(gone).find(({ id }) => id === "dl-3")).toEqual({
      id: "dl-3",
      errorMessage: null,
      errorStack: null,
      withheld: [],
    });
    expect(gone.subscriberFailures[0]?.withheld).toEqual([]);
    expect(gone.answers).toEqual([]);
    const forgotten = await streamOf("c-1", true);
    for await (const _ of forgotten.records);
    expect(forgotten.others()).toEqual([]);
  });

  it("hands a letter listed for whom its work read the text of no one else, as theirs", async () => {
    const { exportOf, storage, register } = await setup();
    await register("c-2", "bea@example.com");
    const [bea] = await storage.personalKeys.list("c-2");
    const sealed = await sealError({
      error: new Error("bea@example.com bounced"),
      person: null,
      keys: keysOver(storage.personalKeys),
      read: [{ person: "c-2", fingerprint: bea?.key.fingerprint ?? null }],
    });
    await storage.deadLetterStore.add({ ...testDeadLetter("dl-1"), ...sealed, person: null });
    expect((await exportOf("c-2")).deadLetters).toEqual([
      expect.objectContaining({
        id: "dl-1",
        errorMessage: "bea@example.com bounced",
        withheld: [],
      }),
    ]);
    expect((await exportOf("c-1")).deadLetters).toEqual([]);
  });

  it("hands a failure whose event named nobody the text of whom its delivery read alone, as theirs", async () => {
    const { exportOf, storage, register } = await setup();
    await register("c-2", "bea@example.com");
    const [bea] = await storage.personalKeys.list("c-2");
    const { errorStack: _stack, ...sealed } = await sealError({
      error: new Error("cannot index bea@example.com"),
      person: null,
      keys: keysOver(storage.personalKeys),
      read: [{ person: "c-2", fingerprint: bea?.key.fingerprint ?? null }],
    });
    await storage.subscriberFailures.record({
      subscriber: "projection:a",
      position: 1,
      eventId: "e-1",
      eventType: "CustomerRegistered",
      person: null,
      ...sealed,
      failedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await exportOf("c-2")).subscriberFailures).toStrictEqual([
      {
        subscriber: "projection:a",
        eventId: "e-1",
        eventType: "CustomerRegistered",
        errorMessage: "cannot index bea@example.com",
        restricted: [],
        withheld: [],
      },
    ]);
    expect((await exportOf("c-1")).subscriberFailures).toEqual([]);
  });
});

// Every call made through `target`, `depth` objects deep, logged by its path as a read.
const loggedReads = <T extends object>(target: T, depth: number, log: string[], path = ""): T =>
  new Proxy(target, {
    get: (object, property) => {
      const found: unknown = Reflect.get(object, property);
      const at = `${path}${String(property)}`;
      if (typeof found === "function") {
        return (...args: unknown[]) => {
          log.push(`read ${at}`);
          return Reflect.apply(found, object, args);
        };
      }
      if (typeof found !== "object" || found === null || depth === 1) return found;
      return loggedReads(found, depth - 1, log, `${at}.`);
    },
  });

describe("streamPersonalData's checks", () => {
  // c-1 has five events, a scheduled command, three dead letters, a subscriber failure and a row:
  // with two records a page, the header and eight pages to check.
  const holding = async () => {
    const context = await setup();
    const { storage, register, place, sealedReminder, failure, table } = context;
    await register("c-1", "ana@example.com");
    for (const orderId of ["o-1", "o-2", "o-3", "o-4"]) {
      await place(orderId, { customerId: "c-1", total: 10 });
    }
    const reminder = await sealedReminder("c-1", "ana@example.com");
    await storage.scheduler.schedule({
      dedupeKey: "command:cmd-1",
      command: { type: "RemindCustomer", aggregateId: "c-1", payload: reminder.payload },
      executeAt: new Date("2026-01-02T00:00:00.000Z"),
      scheduledAt: new Date("2026-01-01T00:00:00.000Z"),
      context: testContext,
      persons: reminder.persons,
    });
    for (const id of ["dl-1", "dl-2", "dl-3"]) {
      await storage.deadLetterStore.add({
        ...testDeadLetter(id),
        ...(await failure("c-1", `${id} for ana@example.com`)),
        person: "c-1",
      });
    }
    const sealed = await failure("c-1", "cannot index ana@example.com");
    await storage.subscriberFailures.record({
      subscriber: "projection:a",
      position: 1,
      eventId: "e-1",
      eventType: "CustomerRegistered",
      person: "c-1",
      errorName: "Error",
      errorMessage: sealed.errorMessage,
      failedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    await table("customerDirectory").insert({
      customerId: "c-1",
      email: "ana@example.com",
      plan: "pro",
    });
    return context;
  };

  const streamWith = (
    { storage, aggregates, readModels }: Awaited<ReturnType<typeof setup>>,
    log: string[],
    onPage: () => Promise<void>,
  ) => {
    const reading = loggedReads(storage, 2, log);
    return streamPersonalData({
      storage: reading,
      aggregates,
      processes: { byName: {} },
      readModels: {
        ...readModels,
        byName: Object.fromEntries(
          Object.entries(readModels.byName).map(([name, readModel]) => [
            name,
            { ...readModel, storage: loggedReads(readModel.storage, 2, log, `${name}.`) },
          ]),
        ),
      },
      sealing: { keys: reading.personalKeys, indexer: null, redactions: async () => [] },
      clock: createFixedClock(),
      batchSize: 2,
      categories,
      recipients: NO_RECIPIENTS,
      transfers: [],
      personId: "c-1",
      includeWithheld: false,
      onPage,
    });
  };

  it("runs once the header is read and once for each page with records, after every read for it and before any of it is handed out", async () => {
    const context = await holding();
    const log: string[] = [];
    const streamed = await streamWith(context, log, async () => {
      log.push("check");
    });
    expect(log.at(-1)).toBe("check");
    expect(log.filter((entry) => entry === "check")).toHaveLength(1);
    for await (const part of streamed.records) log.push(`record ${part.kind}`);
    // Nothing read is handed out before a check has run after it.
    let unchecked: string | null = null;
    const handedUnchecked: string[] = [];
    for (const entry of log) {
      if (entry === "check") unchecked = null;
      else if (entry.startsWith("read ")) unchecked = entry;
      else if (unchecked !== null) handedUnchecked.push(`${entry} after ${unchecked}`);
    }
    expect(handedUnchecked).toEqual([]);
    // One check for each page that hands something out, whatever was read for it.
    const kinds = log.filter((entry) => entry === "check" || entry.startsWith("record "));
    expect(kinds).toEqual([
      "check",
      "check",
      "record event",
      "record event",
      "check",
      "record event",
      "record event",
      "check",
      "record event",
      "check",
      "record scheduledCommand",
      "check",
      "record deadLetter",
      "record deadLetter",
      "check",
      "record deadLetter",
      "check",
      "record subscriberFailure",
      "check",
      "record row",
    ]);
    // The keys a page opens, record by record, are among what it reads before its check.
    expect(log).toContain("read personalKeys.opened");
    expect(log).toContain("read personalKeys.heldAllOf");
  });

  it("hands out nothing of the header or of a page whose check throws, and fails with it", async () => {
    const context = await holding();
    const refused = new Error("restored under it");
    await expect(streamWith(context, [], () => Promise.reject(refused))).rejects.toBe(refused);
    let checks = 0;
    const streamed = await streamWith(context, [], async () => {
      checks += 1;
      if (checks === 3) throw refused;
    });
    const handed: unknown[] = [];
    await expect(
      (async () => {
        for await (const part of streamed.records) handed.push(part);
      })(),
    ).rejects.toBe(refused);
    expect(handed.map((part) => (part as { kind: string }).kind)).toEqual(["event", "event"]);
  });
});
