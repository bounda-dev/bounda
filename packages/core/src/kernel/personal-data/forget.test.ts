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
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import { forgetPersonalData } from "./forget.ts";

const setup = async (storage?: Storage) => {
  const live = storage ?? (await memory().createStorage({ logger: silentLogger }));
  const { logger, entries: logs } = createRecordingLogger();
  const forget = (personId: string) =>
    forgetPersonalData({
      storage: live,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(),
      logger,
      concurrencyRetries: 2,
      personId,
    });
  return { storage: live, forget, logs };
};

describe("forgetPersonalData", () => {
  it("removes the person's key and appends PersonalDataForgotten to their stream, answering like a command", async () => {
    const { storage, forget, logs } = await setup();
    await storage.personalKeys.add("c-1", testPersonalKey("1"));
    expect(await forget("c-1")).toEqual({
      scheduled: false,
      aggregateType: "bounda",
      aggregateId: "c-1",
      version: 1,
      eventIds: ["id-2"],
      eventTypes: ["PersonalDataForgotten"],
      position: 1,
    });
    expect(await storage.personalKeys.get("c-1")).toBeNull();
    expect(await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).toEqual([
      {
        id: "id-2",
        aggregateType: "bounda",
        aggregateId: "c-1",
        version: 1,
        position: 1,
        type: "PersonalDataForgotten",
        payload: { personId: "c-1", cancelledCommands: [], removedDeadLetters: [] },
        timestamp: "2026-01-01T00:00:00.000Z",
        metadata: {
          correlationId: "id-1",
          causationId: "id-1",
          depth: 0,
          schemaVersion: 1,
          system: true,
        },
      },
    ]);
    expect(logs).toContainEqual({
      level: "info",
      message: "personal data forgotten",
      fields: { personId: "c-1", hadKey: true, cancelledCommands: 0, removedDeadLetters: 0 },
    });
  });

  it("forgets a person without a key too, once more on every call", async () => {
    const { storage, forget, logs } = await setup();
    await forget("c-2");
    expect((await forget("c-2")).version).toBe(2);
    expect(await storage.eventStore.lastPosition()).toBe(2);
    expect(logs.map((entry) => entry.fields)).toEqual([
      { personId: "c-2", hadKey: false, cancelledCommands: 0, removedDeadLetters: 0 },
      { personId: "c-2", hadKey: false, cancelledCommands: 0, removedDeadLetters: 0 },
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
      hadKey: false,
      cancelledCommands: 2,
      removedDeadLetters: 1,
    });
  });

  it("refuses an empty id", async () => {
    const { storage, forget } = await setup();
    await expect(forget("")).rejects.toThrow(
      new ValidationError("forget needs the id of the person to forget", [
        { path: ["personId"], message: "Expected a non-empty string" },
      ]),
    );
    await expect(forget(undefined as unknown as string)).rejects.toBeInstanceOf(ValidationError);
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("runs again when the person's stream moved under it, and gives up past the retries", async () => {
    const base = await memory().createStorage({ logger: silentLogger });
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
