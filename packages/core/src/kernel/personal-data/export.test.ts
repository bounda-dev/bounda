import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import { pendingEvent, testContext, testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { appStorage } from "../events/app-event-store.ts";
import { sealCommandPayload } from "./commands.ts";
import { exportPersonalData } from "./export.ts";

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
  readModels: {},
};

const setup = async () => {
  const aggregates = buildAggregates({ registry, ports: {} });
  const written = await memory().createStorage();
  const storage: Storage = appStorage({ storage: written, aggregates });
  const exportOf = (personId: string, batchSize = 2) =>
    exportPersonalData({
      storage,
      aggregates,
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
  return { storage, written, exportOf, register, place, sealedReminder };
};

describe("exportPersonalData", () => {
  it("refuses an empty id, and reads nothing for it", async () => {
    const { exportOf } = await setup();
    await expect(exportOf("")).rejects.toThrow(
      new ValidationError("exportPersonalData needs the id of the person to export", [
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
    });
    expect(await exportOf("c-1", 100)).toEqual(exported);
    expect((await exportOf("c-2")).events.map((event) => event.data)).toEqual([
      { email: "bo@example.com" },
    ]);
    expect((await exportOf("c-3")).events).toEqual([]);
  });

  it("includes the scheduled commands and dead letters that hold the person's fields, opened", async () => {
    const { exportOf, storage, sealedReminder } = await setup();
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
      kind: "scheduled",
      handler: "RemindCustomer",
      eventType: "RemindCustomer",
      payload: ana.payload,
      persons: ana.persons,
    });
    await storage.deadLetterStore.add(testDeadLetter("dl-2"));
    // A command the registry no longer has: its payload is opened, and no field is marked.
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-3"),
      kind: "scheduled",
      handler: "NudgeCustomer",
      eventType: "NudgeCustomer",
      firstFailedAt: "2026-01-01T00:01:00.000Z",
      payload: ana.payload,
      persons: ana.persons,
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
      { id: "dl-1", commandType: "RemindCustomer", data: { email: "ana@example.com" } },
      { id: "dl-3", commandType: "NudgeCustomer", data: {} },
    ]);
    expect(JSON.stringify(exported)).not.toContain("bo@example.com");
  });

  it("reads a forgotten person's fields as null", async () => {
    const { exportOf, register, storage, sealedReminder } = await setup();
    await register("c-1", "ana@example.com");
    const ana = await sealedReminder("c-1", "ana@example.com");
    await storage.scheduler.schedule({
      dedupeKey: "deadline:x",
      command: { type: "RemindCustomer", aggregateId: "c-1", payload: ana.payload },
      executeAt: new Date("2026-01-02T00:00:00.000Z"),
      context: testContext,
      persons: ana.persons,
    });
    await storage.personalKeys.remove("c-1");
    const exported = await exportOf("c-1");
    expect(exported.events.map((event) => event.data)).toEqual([{ email: null }]);
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
