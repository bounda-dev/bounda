import { describe, expect, it, vi } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { PersonStore } from "../../adapter/storage/person-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import {
  ConcurrencyError,
  ProcessingRestrictedError,
  ValidationError,
} from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import { refuseRestricted, restrictedPersonOf } from "./refusal.ts";
import { liftProcessingRestriction, restrictProcessing } from "./restriction.ts";

const setup = async (storage?: Storage) => {
  const live = storage ?? (await memory().createStorage());
  const { logger, entries: logs } = createRecordingLogger();
  const clock = createFixedClock();
  const ids = createSequentialIdGenerator();
  const args = (personId: string) => ({
    storage: live,
    ids,
    clock,
    logger,
    concurrencyRetries: 2,
    personId,
  });
  return {
    storage: live,
    clock,
    logs,
    restrict: (personId: string) => restrictProcessing(args(personId)),
    unrestrict: (personId: string) => liftProcessingRestriction(args(personId)),
  };
};

describe("restrictProcessing", () => {
  it("writes the person's row and appends ProcessingRestricted to their stream, answering like a command", async () => {
    const { storage, restrict, logs } = await setup();
    expect(await restrict("c-1")).toEqual({
      scheduled: false,
      aggregateType: "bounda",
      aggregateId: "c-1",
      version: 1,
      eventIds: ["id-2"],
      eventTypes: ["ProcessingRestricted"],
      position: 1,
    });
    expect(await storage.persons.get("c-1")).toMatchObject({
      person: "c-1",
      restrictedSince: "2026-01-01T00:00:00.000Z",
    });
    expect(await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).toEqual([
      {
        id: "id-2",
        aggregateType: "bounda",
        aggregateId: "c-1",
        version: 1,
        position: 1,
        type: "ProcessingRestricted",
        payload: { personId: "c-1" },
        person: "c-1",
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
    expect(await storage.scheduler.list()).toEqual([]);
    expect(logs).toEqual([
      {
        level: "info",
        message: "processing restricted",
        fields: { personId: "c-1", changed: true },
      },
    ]);
  });

  it("restricts a person once: the second time appends nothing and answers the stream as it is", async () => {
    const { storage, clock, restrict, logs } = await setup();
    await restrict("c-1");
    clock.advance(1_000);
    expect(await restrict("c-1")).toEqual({
      scheduled: false,
      aggregateType: "bounda",
      aggregateId: "c-1",
      version: 1,
      eventIds: [],
      eventTypes: [],
      position: 0,
    });
    expect((await storage.persons.get("c-1"))?.restrictedSince).toBe("2026-01-01T00:00:00.000Z");
    expect(await storage.eventStore.lastPosition()).toBe(1);
    expect(logs.at(-1)?.fields).toEqual({ personId: "c-1", changed: false });
  });

  it("refuses an empty id", async () => {
    const { storage, restrict, unrestrict } = await setup();
    await expect(restrict("")).rejects.toThrow(
      new ValidationError("restrict needs the id of the person", [
        { path: ["personId"], message: "Expected a non-empty string" },
      ]),
    );
    await expect(unrestrict(undefined as unknown as string)).rejects.toThrow(
      new ValidationError("unrestrict needs the id of the person", [
        { path: ["personId"], message: "Expected a non-empty string" },
      ]),
    );
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
    const { restrict, unrestrict } = await setup(racing);
    conflicts = 2;
    expect((await restrict("c-1")).version).toBe(1);
    expect((await base.persons.get("c-1"))?.restrictedSince).not.toBeNull();
    conflicts = 3;
    await expect(unrestrict("c-1")).rejects.toBeInstanceOf(ConcurrencyError);
    expect((await base.persons.get("c-1"))?.restrictedSince).not.toBeNull();
    expect(await base.scheduler.list()).toEqual([]);
  });
});

describe("liftProcessingRestriction", () => {
  it("clears the row, appends ProcessingRestrictionLifted and schedules the retry of the person's letters, together", async () => {
    const { storage, clock, restrict, unrestrict, logs } = await setup();
    await restrict("c-1");
    clock.advance(60_000);
    expect(await unrestrict("c-1")).toEqual({
      scheduled: false,
      aggregateType: "bounda",
      aggregateId: "c-1",
      version: 2,
      eventIds: ["id-4"],
      eventTypes: ["ProcessingRestrictionLifted"],
      position: 2,
    });
    expect(await storage.persons.get("c-1")).toMatchObject({
      person: "c-1",
      restrictedSince: null,
    });
    const [, lifted] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(lifted).toMatchObject({
      type: "ProcessingRestrictionLifted",
      payload: { personId: "c-1" },
      metadata: { correlationId: "id-3", causationId: "id-3", system: true },
    });
    expect(await storage.scheduler.list()).toEqual([
      {
        dedupeKey: "retry-restricted:c-1",
        command: {
          type: "bounda.RetryRestricted",
          aggregateId: "c-1",
          payload: { personId: "c-1" },
        },
        executeAt: "2026-01-01T00:01:00.000Z",
        context: { correlationId: "id-3", causationId: "id-4", depth: 0 },
        attempts: 0,
      },
    ]);
    expect(logs.at(-1)).toEqual({
      level: "info",
      message: "processing restriction lifted",
      fields: { personId: "c-1", changed: true },
    });
  });

  it("lifts nothing for a person not restricted, known or not", async () => {
    const { storage, restrict, unrestrict } = await setup();
    expect(await unrestrict("c-1")).toMatchObject({ version: 0, eventIds: [], position: 0 });
    expect(await storage.persons.get("c-1")).toBeNull();
    await restrict("c-1");
    await unrestrict("c-1");
    expect(await unrestrict("c-1")).toMatchObject({ version: 2, eventIds: [], position: 0 });
    expect(await storage.eventStore.lastPosition()).toBe(2);
    expect(await storage.scheduler.list()).toHaveLength(1);
  });
});

describe("refuseRestricted", () => {
  it("throws for a restricted person, and lets through nobody, an unknown person and a lifted one", async () => {
    const { storage, restrict, unrestrict } = await setup();
    const { persons } = storage;
    await restrict("c-1");
    await restrict("c-2");
    await unrestrict("c-2");
    const refused = await refuseRestricted({ persons, person: "c-1" }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ProcessingRestrictedError);
    expect(refused).toMatchObject({
      code: "PROCESSING_RESTRICTED",
      personId: "c-1",
      message: "The processing of this person's data is restricted",
    });
    await expect(refuseRestricted({ persons, person: null })).resolves.toBeUndefined();
    await expect(refuseRestricted({ persons, person: "c-2" })).resolves.toBeUndefined();
    await expect(refuseRestricted({ persons, person: "c-3" })).resolves.toBeUndefined();
    expect(restrictedPersonOf(refused)).toBe("c-1");
    expect(restrictedPersonOf(new Error("boom"))).toBeNull();
  });

  it("reads nothing for work that touches nobody", async () => {
    const persons: PersonStore = {
      get: vi.fn(),
      restrict: vi.fn(),
      unrestrict: vi.fn(),
      record: vi.fn(),
      listIdle: vi.fn(),
      hold: vi.fn(),
      nextHoldEnd: vi.fn(),
    };
    await refuseRestricted({ persons, person: null });
    expect(persons.get).not.toHaveBeenCalled();
  });
});
