import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { KeyedPerson } from "../../adapter/storage/personal-key-store.ts";
import {
  testCommand,
  testContext,
  testDeadLetter,
  testKeyedPerson,
  testPersonalKey,
} from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { memory } from "../../memory/index.ts";
import type { ForgetOptions, PersonalDataModule } from "../../modules/personal-data.ts";
import { createRecordingLogger } from "../test-support.ts";
import { buildPersonalCategories } from "./categories.ts";
import { forgetPersonalData } from "./forget.ts";

const DAY_MS = 86_400_000;

const declared: PersonalDataModule = {
  categories: {
    profile: { basis: "consent", retention: "30d" },
    invoices: { basis: "legal-obligation", retention: "30d" },
  },
};

const setup = async (storage?: Storage, module?: PersonalDataModule) => {
  const live = storage ?? (await memory().createStorage());
  const { logger, entries: logs } = createRecordingLogger();
  const clock = createFixedClock();
  const forget = (personId: string, options?: ForgetOptions) =>
    forgetPersonalData({
      storage: live,
      ids: createSequentialIdGenerator(),
      clock,
      logger,
      concurrencyRetries: 2,
      categories: buildPersonalCategories({ module, retentionMs: null }),
      batchSize: 10,
      personId,
      options,
    });
  return { storage: live, forget, logs, clock };
};

const forgottenFields = {
  reason: "requested",
  whole: true,
  categories: ["default"],
  retained: [],
  expired: [],
};

describe("forgetPersonalData", () => {
  it("removes the person's key and appends PersonalDataForgotten to their stream, answering like a command", async () => {
    const { storage, forget, logs } = await setup();
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    expect(await forget("c-1")).toEqual({
      scheduled: false,
      aggregateType: "bounda",
      aggregateId: "c-1",
      version: 1,
      eventIds: ["id-2"],
      eventTypes: ["PersonalDataForgotten"],
      position: 1,
    });
    expect(await storage.personalKeys.list("c-1")).toEqual([]);
    expect(await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).toEqual([
      {
        id: "id-2",
        aggregateType: "bounda",
        aggregateId: "c-1",
        version: 1,
        position: 1,
        type: "PersonalDataForgotten",
        payload: {
          personId: "c-1",
          ...forgottenFields,
          cancelledCommands: [],
          removedDeadLetters: [],
        },
        timestamp: "2026-01-01T00:00:00.000Z",
        metadata: {
          correlationId: "id-1",
          causationId: "id-1",
          depth: 0,
          schemaVersion: 1,
          system: true,
        },
        person: "c-1",
      },
    ]);
    expect(logs).toContainEqual({
      level: "info",
      message: "personal data forgotten",
      fields: {
        personId: "c-1",
        ...forgottenFields,
        destroyedKeys: 1,
        cancelledCommands: 0,
        removedDeadLetters: 0,
      },
    });
  });

  it("forgets a person without a key too, once more on every call", async () => {
    const { storage, forget, logs } = await setup();
    await forget("c-2");
    expect((await forget("c-2")).version).toBe(2);
    expect(await storage.eventStore.lastPosition()).toBe(2);
    expect(logs.map((entry) => entry.fields)).toEqual([
      {
        personId: "c-2",
        ...forgottenFields,
        destroyedKeys: 0,
        cancelledCommands: 0,
        removedDeadLetters: 0,
      },
      {
        personId: "c-2",
        ...forgottenFields,
        destroyedKeys: 0,
        cancelledCommands: 0,
        removedDeadLetters: 0,
      },
    ]);
  });

  it("cancels the scheduled commands and removes the dead letters that name the person, naming them", async () => {
    const { storage, forget, logs } = await setup();
    const persons = [testKeyedPerson("c-1", "1")];
    const schedule = (dedupeKey: string, aggregateId: string, named: readonly KeyedPerson[]) =>
      storage.scheduler.schedule({
        dedupeKey,
        command: testCommand(aggregateId),
        executeAt: new Date("2026-01-01T00:01:00.000Z"),
        context: testContext,
        persons: named,
      });
    await schedule("command:cmd-1", "c-1", persons);
    await schedule("deadline:x", "c-1", persons);
    await schedule("command:cmd-2", "c-2", [testKeyedPerson("c-2", "2")]);
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-1"),
      kind: "scheduled",
      handler: "RemindCustomer",
      persons,
    });
    await storage.deadLetterStore.add(testDeadLetter("dl-2"));
    await forget("c-1");
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(event?.payload).toEqual({
      personId: "c-1",
      ...forgottenFields,
      cancelledCommands: [
        { commandId: "cmd-1", type: "RemindCustomer" },
        { commandId: "deadline:x", type: "RemindCustomer" },
      ],
      removedDeadLetters: [{ id: "dl-1", commandType: "RemindCustomer" }],
    });
    expect((await storage.scheduler.list()).map((entry) => entry.dedupeKey)).toEqual([
      "command:cmd-2",
    ]);
    expect((await storage.deadLetterStore.list()).map((letter) => letter.id)).toEqual(["dl-2"]);
    expect(logs.at(-1)?.fields).toEqual({
      personId: "c-1",
      ...forgottenFields,
      destroyedKeys: 0,
      cancelledCommands: 2,
      removedDeadLetters: 1,
    });
  });

  it("forgets only the categories named, keeping what is sealed under the other keys", async () => {
    const { storage, forget, logs } = await setup(undefined, declared);
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "profile", testPersonalKey("2"));
    const schedule = (dedupeKey: string, named: readonly KeyedPerson[]) =>
      storage.scheduler.schedule({
        dedupeKey,
        command: testCommand("c-1"),
        executeAt: new Date("2026-01-01T00:01:00.000Z"),
        context: testContext,
        persons: named,
      });
    await schedule("command:cmd-1", [testKeyedPerson("c-1", "1")]);
    await schedule("command:cmd-2", [testKeyedPerson("c-1", "2")]);
    await schedule("command:cmd-3", [testKeyedPerson("c-1", null)]);
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-1"),
      persons: [testKeyedPerson("c-1", "1")],
    });
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-2"),
      persons: [testKeyedPerson("c-1", "2")],
    });
    await forget("c-1", { categories: ["profile"] });
    expect((await storage.personalKeys.list("c-1")).map(({ category }) => category)).toEqual([
      "default",
    ]);
    expect((await storage.scheduler.list()).map((entry) => entry.dedupeKey)).toEqual([
      "command:cmd-1",
    ]);
    expect((await storage.deadLetterStore.list()).map((letter) => letter.id)).toEqual(["dl-1"]);
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(event?.payload).toEqual({
      personId: "c-1",
      reason: "requested",
      whole: false,
      categories: ["profile"],
      retained: [],
      expired: [],
      cancelledCommands: [
        { commandId: "cmd-2", type: "RemindCustomer" },
        { commandId: "cmd-3", type: "RemindCustomer" },
      ],
      removedDeadLetters: [{ id: "dl-2", commandType: "order.p" }],
    });
    expect(logs.at(-1)?.fields).toMatchObject({ whole: false, destroyedKeys: 1 });
  });

  it("retains a key under a legal obligation while its retention runs from the last activity", async () => {
    const { storage, forget, clock } = await setup(undefined, declared);
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("2"));
    const lastActiveAt = new Date(clock.now().getTime() - 10 * DAY_MS).toISOString();
    await storage.persons.record({ person: "c-1", position: 1, lastActiveAt, forgottenAt: null });
    await forget("c-1");
    expect(await storage.personalKeys.list("c-1")).toEqual([
      {
        category: "invoices",
        key: testPersonalKey("2"),
        retainedSince: clock.now().toISOString(),
        lastActiveAt,
      },
    ]);
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(event?.payload).toMatchObject({
      whole: true,
      categories: ["default", "profile"],
      retained: ["invoices"],
      expired: [],
    });
  });

  it("retains a key under a legal obligation when its category is named, too", async () => {
    const { storage, forget } = await setup(undefined, declared);
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("2"));
    await forget("c-1", { categories: ["invoices"] });
    expect(
      (await storage.personalKeys.list("c-1")).map(({ retainedSince }) => retainedSince),
    ).toEqual(["2026-01-01T00:00:00.000Z"]);
    expect(await storage.personalKeys.get("c-1", "invoices")).toBeNull();
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(event?.payload).toMatchObject({
      whole: false,
      categories: [],
      retained: ["invoices"],
      expired: [],
    });
  });

  it("destroys a key under a legal obligation once its retention has run out", async () => {
    const { storage, forget, clock } = await setup(undefined, declared);
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("2"));
    await storage.persons.record({
      person: "c-1",
      position: 1,
      lastActiveAt: new Date(clock.now().getTime() - 31 * DAY_MS).toISOString(),
      forgottenAt: null,
    });
    await forget("c-1");
    expect(await storage.personalKeys.list("c-1")).toEqual([]);
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(event?.payload).toMatchObject({
      whole: true,
      categories: ["default", "profile", "invoices"],
      retained: [],
      expired: [],
    });
  });

  it("refuses categories that are empty or that the app does not have, forgetting nothing", async () => {
    const { storage, forget } = await setup(undefined, declared);
    await expect(forget("c-1", { categories: [] })).rejects.toThrow(
      new ValidationError("forget needs at least one category when it names them", [
        { path: ["categories"], message: "Expected a non-empty array of categories" },
      ]),
    );
    await expect(
      forget("c-1", {
        categories: ["profile", "orders"] as unknown as ["default"],
      }),
    ).rejects.toThrow('forget names categories the app does not have: "orders"');
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("refuses an empty id", async () => {
    const { storage, forget } = await setup();
    await expect(forget("")).rejects.toThrow(
      new ValidationError("forget needs the id of the person", [
        { path: ["personId"], message: "Expected a non-empty string" },
      ]),
    );
    await expect(forget(undefined as unknown as string)).rejects.toBeInstanceOf(ValidationError);
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("runs again when the person's stream moved under it, and gives up past the retries", async () => {
    const base = await memory().createStorage();
    let conflicts = 0;
    const racing: Storage = {
      ...base,
      transact: (work) =>
        base.transact(async (transaction) => {
          const result = await work(transaction);
          if (conflicts > 0) {
            conflicts -= 1;
            throw new ConcurrencyError({
              streamId: "bounda:c-1",
              expectedVersion: 0,
              actualVersion: 1,
            });
          }
          return result;
        }),
    };
    const { forget } = await setup(racing);
    conflicts = 2;
    expect((await forget("c-1")).version).toBe(1);
    conflicts = 3;
    await expect(forget("c-1")).rejects.toBeInstanceOf(ConcurrencyError);
  });
});
