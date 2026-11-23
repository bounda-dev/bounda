import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { KeyedPerson } from "../../adapter/storage/personal-key-store.ts";
import {
  pendingEvent,
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
import { createRecordingLogger, withoutLedger } from "../test-support.ts";
import { buildPersonalCategories } from "./categories.ts";
import { forgetIntended, forgetPersonalData, forgetWithin, STALE_INTENTION } from "./forget.ts";
import { boundForgetLedger } from "./forget-ledger.ts";
import { createForgetIntentions } from "./intention.ts";

const DAY_MS = 86_400_000;

const declared: PersonalDataModule = {
  automatedDecisions: {},
  categories: {
    profile: {
      basis: "consent",
      retention: "30d",
      purposes: ["Serve the person"],
      sources: ["data-subject"],
    },
    invoices: {
      basis: "legal-obligation",
      retention: "30d",
      purposes: ["Serve the person"],
      sources: ["data-subject"],
    },
  },
};

const said = { retention: "30d", purposes: ["Serve the person"], sources: ["data-subject"] };

const health = (condition: string) => ({ kinds: ["health"], condition });

// A category for each exemption of article 17(3), and some no exemption spares.
const exempted = {
  automatedDecisions: {},
  categories: {
    invoices: { basis: "legal-obligation", ...said },
    news: { basis: "consent", ...said, processedFor: ["direct-marketing"] },
    census: { basis: "public-task", ...said, processedFor: ["statistics"] },
    lab: { basis: "contract", ...said, special: health("public-health") },
    care: { basis: "contract", ...said, special: health("health-or-social-care") },
    consented: { basis: "consent", ...said, special: health("legal-claims") },
    study: {
      basis: "legitimate-interests",
      ...said,
      processedFor: ["scientific-or-historical-research"],
      erasureExemption: "archiving-research-or-statistics",
    },
    dispute: { basis: "legitimate-interests", ...said, special: health("legal-claims") },
    screening: { basis: "legitimate-interests", ...said, special: health("public-health") },
  },
} as unknown as PersonalDataModule;

// A key in force of every category of `exempted`, the person active a day ago.
const holdEvery = async (storage: Storage) => {
  const names = ["default", ...Object.keys(exempted.categories)];
  for (const [index, category] of names.entries()) {
    await storage.personalKeys.add("c-1", category, testPersonalKey(String(index)));
  }
  await storage.persons.record({
    person: "c-1",
    position: 1,
    lastActiveAt: "2025-12-31T00:00:00.000Z",
    forgottenAt: null,
  });
};

// The categories whose key a forgetting kept, in the order the store lists them.
const keptOf = async (storage: Storage) =>
  (await storage.personalKeys.list("c-1"))
    .filter(({ retainedSince }) => retainedSince !== null)
    .map(({ category }) => category);

const setup = async (storage?: Storage, module?: PersonalDataModule) => {
  const live = storage ?? (await memory().createStorage());
  const { logger, entries: logs } = createRecordingLogger();
  const ids = createSequentialIdGenerator();
  const clock = createFixedClock();
  const forget = (personId: string, options?: ForgetOptions) =>
    forgetPersonalData({
      storage: live,
      intentions: withoutLedger({ ids, clock }),
      ids,
      clock,
      logger,
      concurrencyRetries: 2,
      categories: buildPersonalCategories({ module, retention: null }),
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
          fingerprints: ["f-1"],
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
        scheduledAt: new Date("2026-01-01T00:01:00.000Z"),
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
      fingerprints: [],
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
        scheduledAt: new Date("2026-01-01T00:01:00.000Z"),
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
      fingerprints: ["f-2"],
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

  it("keeps every category an exemption of article 17(3) spares, and nothing on consent", async () => {
    const { storage, forget } = await setup(undefined, exempted);
    await holdEvery(storage);
    await forget("c-1");
    expect(await keptOf(storage)).toEqual([
      "invoices",
      "census",
      "lab",
      "study",
      "dispute",
      "screening",
    ]);
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(event?.payload).toMatchObject({
      reason: "requested",
      whole: true,
      categories: ["default", "news", "care", "consented"],
      retained: ["invoices", "census", "lab", "study", "dispute", "screening"],
      expired: [],
    });
  });

  it("after an objection, keeps of what it reaches only what a legal obligation or legal claims keep", async () => {
    const { storage, forget } = await setup(undefined, exempted);
    await holdEvery(storage);
    await forget("c-1", { objection: true });
    expect(await keptOf(storage)).toEqual(["invoices", "lab", "dispute"]);
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(event?.payload).toMatchObject({
      reason: "objection",
      whole: true,
      categories: ["default", "news", "census", "care", "consented", "study", "screening"],
      retained: ["invoices", "lab", "dispute"],
      expired: [],
    });
  });

  it("ends, after an objection, what an earlier forgetting kept that the objection reaches, and only that", async () => {
    const { storage, forget } = await setup(undefined, exempted);
    await holdEvery(storage);
    await forget("c-1");
    const before = await storage.personalKeys.list("c-1");
    await forget("c-1", { categories: ["census", "lab", "dispute", "invoices"], objection: true });
    expect(await keptOf(storage)).toEqual(["invoices", "lab", "study", "dispute", "screening"]);
    const events = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(events[1]?.payload).toMatchObject({
      reason: "objection",
      whole: false,
      categories: ["census"],
      retained: ["lab", "dispute", "invoices"],
      expired: [],
      fingerprints: [before.find(({ category }) => category === "census")?.key.fingerprint],
    });
    // A request again ends nothing an earlier forgetting kept.
    await forget("c-1", { categories: ["study"] });
    expect(await keptOf(storage)).toEqual(["invoices", "lab", "study", "dispute", "screening"]);
    // Kept when it was declared otherwise, a category for direct marketing goes at an objection.
    await storage.personalKeys.add("c-1", "news", testPersonalKey("n"));
    await storage.personalKeys.retain("c-1", "f-n", {
      since: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    await forget("c-1", { categories: ["news"] });
    expect(await keptOf(storage)).toContain("news");
    await forget("c-1", { categories: ["news"], objection: true });
    expect(await keptOf(storage)).not.toContain("news");
  });

  it("leaves to the retention what an earlier forgetting kept of a category no objection reaches", async () => {
    const { storage, forget } = await setup(undefined, exempted);
    await storage.personalKeys.add("c-1", "care", testPersonalKey("1"));
    await storage.personalKeys.retain("c-1", "f-1", {
      since: "2025-12-31T00:00:00.000Z",
      lastActiveAt: "2025-12-31T00:00:00.000Z",
    });
    // Nor of one the app no longer declares, which the retention ends as well.
    await storage.personalKeys.add("c-1", "dropped", testPersonalKey("2"));
    await storage.personalKeys.retain("c-1", "f-2", {
      since: "2025-12-31T00:00:00.000Z",
      lastActiveAt: "2025-12-31T00:00:00.000Z",
    });
    await forget("c-1", { objection: true });
    expect(await keptOf(storage)).toEqual(["care", "dropped"]);
  });

  it("takes objection as a boolean, recording a request without it", async () => {
    const { storage, forget } = await setup(undefined, exempted);
    await storage.personalKeys.add("c-1", "census", testPersonalKey("1"));
    for (const wrong of ["yes", 1, null]) {
      await expect(
        forget("c-1", { objection: wrong } as unknown as ForgetOptions),
      ).rejects.toMatchObject({
        message: "forget takes objection as true or false",
        issues: [{ path: ["objection"], message: "Expected a boolean" }],
      });
    }
    expect(await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).toEqual([]);
    await forget("c-1", { objection: false });
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(event?.payload).toMatchObject({ reason: "requested", retained: ["census"] });
  });

  it("refuses categories that are empty or that the app does not have, forgetting nothing", async () => {
    const { storage, forget } = await setup(undefined, declared);
    await expect(forget("c-1", { categories: [] })).rejects.toThrow(
      new ValidationError("forget needs at least one category when it names them", [
        { path: ["categories"], message: "Expected a non-empty array of categories" },
      ]),
    );
    const refusal = await forget("c-1", {
      categories: ["profile", "orders", 3, "bills"] as unknown as ["default"],
    }).catch((error: unknown) => error);
    expect(refusal).toEqual(
      new ValidationError('forget names categories the app does not have: "orders", 3, "bills"', [
        {
          path: ["categories"],
          message: 'Expected categories app/personal-data.ts declares, or "default"',
        },
      ]),
    );
    expect(refusal).toMatchObject({
      issues: [
        {
          path: ["categories"],
          message: 'Expected categories app/personal-data.ts declares, or "default"',
        },
      ],
    });
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("destroys a key under a legal obligation whose retention ends at the forgetting itself", async () => {
    const { storage, forget, clock } = await setup(undefined, declared);
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("2"));
    await storage.persons.record({
      person: "c-1",
      position: 1,
      lastActiveAt: new Date(clock.now().getTime() - 30 * DAY_MS).toISOString(),
      forgottenAt: null,
    });
    await forget("c-1");
    expect(await storage.personalKeys.list("c-1")).toEqual([]);
  });

  it("destroys the key of a category the app no longer declares", async () => {
    const { storage, forget } = await setup(undefined, declared);
    await storage.personalKeys.add("c-1", "retired", testPersonalKey("9"));
    await forget("c-1");
    expect(await storage.personalKeys.list("c-1")).toEqual([]);
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

describe("forgetIntended", () => {
  const recordingIntentions = (ids = createSequentialIdGenerator()) => {
    const recorded: ForgetLedgerEntry[] = [];
    const clock = createFixedClock();
    const intentions = createForgetIntentions({
      ledger: {
        store: boundForgetLedger({
          ledger: {
            readMark: async () => 0,
            raiseMark: async () => undefined,
            clear: async () => true,
            append: async (entries) => {
              recorded.push(...entries);
            },
            read: async () => [],
          },
          timeoutMs: 1_000,
          clock,
        }),
        strict: true,
      },
      ids,
      clock,
      logger: createRecordingLogger().logger,
    });
    return { intentions, recorded, ids, clock };
  };

  it("takes a new intention that names a key given to the person between the intention and the commit", async () => {
    const base = await memory().createStorage();
    await base.personalKeys.add("c-1", "default", testPersonalKey("1"));
    let raced = false;
    const racing: Storage = {
      ...base,
      transact: async (work) => {
        if (!raced) {
          raced = true;
          // Another forgetting committed meanwhile, and the person came back with a new key.
          await base.personalKeys.remove("c-1", "f-1");
          await base.personalKeys.add("c-1", "default", testPersonalKey("2"));
        }
        return base.transact(work);
      },
    };
    const { intentions, recorded, ids, clock } = recordingIntentions();
    const forgotten = await forgetIntended({
      storage: racing,
      intentions,
      ids,
      clock,
      concurrencyRetries: 0,
      categories: buildPersonalCategories({ module: undefined, retention: null }),
      batchSize: 10,
      personId: "c-1",
      scope: { kind: "whole" },
      reason: "requested",
      context: testContext,
    });
    expect(recorded.map(({ eventId, fingerprints }) => [eventId, fingerprints])).toEqual([
      ["id-1", ["f-1"]],
      ["id-2", ["f-2"]],
    ]);
    expect(forgotten).toMatchObject({
      destroyed: 1,
      event: { id: "id-2", payload: { fingerprints: ["f-2"] } },
    });
    expect(await base.personalKeys.get("c-1", "default")).toBeNull();
  });

  it("forgets a person whose key went since the intention, naming none", async () => {
    const base = await memory().createStorage();
    await base.personalKeys.add("c-1", "default", testPersonalKey("1"));
    let raced = false;
    const racing: Storage = {
      ...base,
      transact: async (work) => {
        if (!raced) {
          raced = true;
          await base.personalKeys.remove("c-1", "f-1");
        }
        return base.transact(work);
      },
    };
    const { intentions, recorded, ids, clock } = recordingIntentions();
    const forgotten = await forgetIntended({
      storage: racing,
      intentions,
      ids,
      clock,
      concurrencyRetries: 0,
      categories: buildPersonalCategories({ module: undefined, retention: null }),
      batchSize: 10,
      personId: "c-1",
      scope: { kind: "whole" },
      reason: "requested",
      context: testContext,
    });
    expect(recorded).toHaveLength(1);
    expect(forgotten).toMatchObject({ destroyed: 0, payload: { fingerprints: [] } });
  });

  it("answers with the forgetting a reconciliation committed under the intention's id meanwhile", async () => {
    const { storage, logs } = await setup();
    const intended = {
      eventId: "id-1",
      forgottenAt: "2026-01-01T00:00:00.000Z",
      reason: "requested" as const,
      fingerprints: [],
    };
    await storage.eventStore.append({
      aggregateType: "bounda",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [
        {
          ...pendingEvent({
            aggregateType: "bounda",
            aggregateId: "c-1",
            version: 1,
            type: "PersonalDataForgotten",
            id: "id-1",
          }),
          person: "c-1",
        },
      ],
    });
    const dispatch = await forgetPersonalData({
      storage,
      intentions: {
        intend: async () => intended,
        record: async () => undefined,
        disclose: async () => undefined,
      },
      ids: createSequentialIdGenerator({ prefix: "other" }),
      clock: createFixedClock(),
      logger: createRecordingLogger().logger,
      concurrencyRetries: 0,
      categories: buildPersonalCategories({ module: undefined, retention: null }),
      batchSize: 10,
      personId: "c-1",
    });
    expect(dispatch).toMatchObject({ eventIds: ["id-1"], version: 1, position: 1 });
    expect(await storage.eventStore.lastPosition()).toBe(1);
    expect(logs).toEqual([]);
  });

  it("reads the held event and checks the key only when its caller has not", async () => {
    const storage = await memory().createStorage();
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    let reads = 0;
    const forget = (checked: boolean, fingerprints: readonly string[]) =>
      storage.transact((transaction) => {
        const { readOne } = transaction.eventStore;
        return forgetWithin({
          transaction: {
            ...transaction,
            eventStore: {
              ...transaction.eventStore,
              readOne: (args) => {
                reads += 1;
                return readOne.call(transaction.eventStore, args);
              },
            },
          },
          ids: createSequentialIdGenerator(),
          clock: createFixedClock(),
          personId: "c-1",
          intention: {
            eventId: `e-${checked}`,
            forgottenAt: "t",
            reason: "requested",
            fingerprints,
          },
          context: testContext,
          categories: buildPersonalCategories({ module: undefined, retention: null }),
          scope: { kind: "whole" },
          batchSize: 10,
          checked,
        });
      });
    expect(await forget(false, ["f-other"])).toBe(STALE_INTENTION);
    expect(reads).toBe(1);
    // A caller that checked keeps a key the intention does not name: given after it.
    expect(await forget(true, ["f-other"])).toMatchObject({
      destroyed: 0,
      event: {
        id: "e-true",
        payload: { fingerprints: [], whole: false, categories: [], retained: [] },
      },
    });
    expect(reads).toBe(1);
    expect(await storage.personalKeys.list("c-1")).toHaveLength(1);
  });
});
