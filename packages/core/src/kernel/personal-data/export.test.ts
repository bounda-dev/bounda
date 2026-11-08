import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
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
import { appStorage } from "../events/app-event-store.ts";
import { buildReadModels } from "../read-model/build-read-models.ts";
import { sealCommandPayload } from "./commands.ts";
import { sealError } from "./errors.ts";
import { exportPersonalData } from "./export.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

type Table = RowTable<Record<string, unknown>>;

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
              note: personal(z.string()).optional(),
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
          note: f.string().personal().optional(),
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
};

const setup = async () => {
  const aggregates = buildAggregates({ registry, ports: {} });
  // A read model of its own adapter, as `readModels` in the configuration may give it.
  const readModels = await buildReadModels({
    registry,
    config: resolveConfig({ storage: memory(), readModels: { orderNotes: memory() } }),
    logger: silentLogger,
  });
  const table = (name: string) => {
    const readModel = readModels.byName[name];
    if (readModel === undefined) throw new Error(`no read model ${name}`);
    return readModel.storage.table;
  };
  const written = await memory().createStorage();
  const storage: Storage = appStorage({
    storage: written,
    aggregates,
    wrapping: createPersonalKeyWrapping({ wrapper: null, clock: createFixedClock() }),
  });
  const exportOf = (personId: string, batchSize = 2) =>
    exportPersonalData({
      storage,
      aggregates,
      readModels,
      clock: createFixedClock(),
      batchSize,
      personId,
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
      keys: storage.personalKeys,
    });
  // An error whose message quotes the person, as a handler's may.
  const failure = (person: string | null, message: string) => {
    const error = new Error(message);
    error.stack = `Error: ${message}\n    at handler`;
    return sealError({ error, person, keys: storage.personalKeys });
  };
  return {
    storage,
    written,
    exportOf,
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
        },
      ],
      scheduledCommands: [],
      deadLetters: [],
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

  it("includes the scheduled commands and dead letters that hold the person's fields, opened", async () => {
    const { exportOf, storage, sealedReminder, failure } = await setup();
    const ana = await sealedReminder("c-1", "ana@example.com");
    const bo = await sealedReminder("c-2", "bo@example.com");
    await storage.scheduler.schedule({
      dedupeKey: "command:cmd-1",
      command: { type: "RemindCustomer", aggregateId: "c-1", payload: ana.payload },
      executeAt: new Date("2026-01-02T00:00:00.000Z"),
      context: testContext,
      persons: ana.persons,
    });
    await storage.scheduler.schedule({
      dedupeKey: "command:cmd-2",
      command: { type: "RemindCustomer", aggregateId: "c-2", payload: bo.payload },
      executeAt: new Date("2026-01-02T00:00:00.000Z"),
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
    expect(exported.scheduledCommands).toEqual([
      {
        commandId: "cmd-1",
        type: "RemindCustomer",
        executeAt: "2026-01-02T00:00:00.000Z",
        data: { email: "ana@example.com" },
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
      },
      { id: "dl-3", kind: "scheduled", handler: "NudgeCustomer", data: {} },
      {
        id: "dl-4",
        kind: "policy",
        handler: "order.p",
        errorMessage: "ana@example.com bounced",
        errorStack: "Error: ana@example.com bounced\n    at handler",
        data: {},
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain("bo@example.com");
  });

  it("includes the rows of every read model with a person field, page by page, with their key and marked fields only", async () => {
    const { exportOf, table } = await setup();
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
      customerDirectory: [{ key: "c-1", data: { email: "ana@example.com" } }],
      orderNotes: [
        { key: "o-1", data: { note: "ring twice" } },
        { key: "o-3", data: { note: "leave at door" } },
        { key: "o-4", data: {} },
      ],
      orderCustomers: [
        { key: "o-1", data: {} },
        { key: "o-3", data: {} },
        { key: "o-4", data: {} },
      ],
    });
    expect(await exportOf("c-1", 100)).toEqual(exported);
    // One row a page: the person field that is the directory's key stays the person's.
    expect(await exportOf("c-1", 1)).toEqual(exported);
    expect(JSON.stringify(exported)).not.toContain("bo");
    expect(JSON.stringify(exported)).not.toContain("pro");
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
        readModels: { ...readModels, byName: { ...readModels.byName, orderNotes: writing } },
        clock: createFixedClock(),
        batchSize: 3,
        personId: "c-1",
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
        readModels: { ...readModels, byName: failing },
        clock: createFixedClock(),
        batchSize: 2,
        personId: "c-1",
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
      context: testContext,
      persons: ana.persons,
    });
    const { errorStack: _stack, ...withoutStack } = await failure("c-1", "ana@example.com bounced");
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-1"),
      ...withoutStack,
      person: "c-1",
    });
    await storage.personalKeys.remove("c-1");
    const exported = await exportOf("c-1");
    expect(exported.events.map((event) => event.data)).toEqual([{ email: null }]);
    expect(exported.deadLetters).toStrictEqual([
      { id: "dl-1", kind: "policy", handler: "order.p", errorMessage: null, data: {} },
    ]);
    expect(exported.scheduledCommands).toEqual([
      {
        commandId: "deadline:x",
        type: "RemindCustomer",
        executeAt: "2026-01-02T00:00:00.000Z",
        data: { email: null },
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain("ana@example.com");
  });
});
