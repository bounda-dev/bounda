import { describe, expect, it } from "vitest";
import type { NewDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import { testDeadLetter } from "../../adapter/testing/fixtures.ts";
import {
  DeadLetterNotRetriableError,
  DeadLetterSettledError,
  ProcessingRestrictedError,
} from "../../contracts/errors.ts";
import { liftProcessingRestriction } from "../personal-data/restriction.ts";
import { PROCESS_DEADLINE_COMMAND } from "../process/deadlines.ts";
import { PROCESSES_SUBSCRIBER } from "../process/runner.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { DEADLINE_WAIT_ROUNDS } from "../scheduler/worker.ts";
import { createRecordingLogger, orderRegistry } from "../test-support.ts";
import { createUnitOfWork } from "../unit-of-work/unit-of-work.ts";
import { createRestrictedRetries } from "./restricted.ts";

const refused = (
  id: string,
  command: string,
  orderId: string,
  person: string,
  firstFailedAt: string,
  errorCode = "PROCESSING_RESTRICTED",
): NewDeadLetter => ({
  ...testDeadLetter(id),
  kind: "scheduled",
  handler: command,
  eventId: `command:${id}`,
  eventType: command,
  aggregateType: "order",
  aggregateId: orderId,
  person,
  errorName: "ProcessingRestrictedError",
  errorCode,
  firstFailedAt,
  lastFailedAt: firstFailedAt,
  payload: { orderId },
});

const setup = async (config?: Parameters<typeof createReactiveHarness>[0]["config"]) => {
  const { logger, entries } = createRecordingLogger();
  const harness = await createReactiveHarness({
    registry: orderRegistry,
    logger,
    ...(config === undefined ? {} : { config }),
  });
  const lift = (personId: string) =>
    liftProcessingRestriction({
      storage: harness.storage,
      ids: harness.ids,
      clock: harness.clock,
      logger,
      concurrencyRetries: 2,
      personId,
    });
  return { harness, entries, lift };
};

describe("the retry of a restricted person's dead letters", () => {
  it("retries them in order once the runners caught up, and files again under the same id one that fails for another reason", async () => {
    const { harness, entries, lift } = await setup();
    const { deadLetterStore } = harness.storage;
    await harness.storage.persons.restrict("c-1", harness.clock.now());
    await deadLetterStore.add(refused("later", "TouchOrder", "o-1", "c-1", "2026-01-01T00:02:00Z"));
    await deadLetterStore.add(
      refused("broken", "BreakOrder", "o-2", "c-1", "2026-01-01T00:01:00Z"),
    );
    await deadLetterStore.add(refused("other", "TouchOrder", "o-3", "c-2", "2026-01-01T00:00:00Z"));
    await deadLetterStore.add(
      refused("coded", "TouchOrder", "o-4", "c-1", "2026-01-01T00:00:00Z", "VALIDATION_FAILED"),
    );
    await deadLetterStore.add({
      ...refused("gone", "TouchOrder", "o-5", "c-1", "2026-01-01T00:00:00Z"),
      kind: "policy",
      handler: "order.gone",
    });
    await lift("c-1");
    harness.clock.advance(60_000);

    // The entry waits for the policy and process runners, as a deadline does.
    expect(await harness.worker.runOnce()).toBe(1);
    expect(harness.worker.waitingDeadlines()).toBe(1);
    expect((await deadLetterStore.get("later"))?.status).toBe("failed");
    await harness.dispatcher.runUntilIdle();
    expect(await harness.worker.runOnce()).toBe(1);
    expect(harness.worker.waitingDeadlines()).toBe(0);
    expect(await harness.storage.scheduler.list()).toEqual([]);

    expect((await deadLetterStore.list()).map(({ id, status }) => [id, status])).toEqual([
      ["coded", "failed"],
      ["gone", "failed"],
      ["other", "failed"],
      ["broken", "failed"],
      ["later", "retried"],
    ]);
    const broken = await deadLetterStore.get("broken");
    expect(broken).toMatchObject({
      kind: "scheduled",
      handler: "BreakOrder",
      person: "c-1",
      errorType: "terminal",
      errorName: "ConfigurationError",
      errorCode: "INVALID_CONFIGURATION",
      errorMessage: { $personal: { person: "c-1" } },
      attempts: 2,
      firstFailedAt: "2026-01-01T00:01:00Z",
      lastFailedAt: "2026-01-01T00:01:00.000Z",
      payload: { orderId: "o-2" },
    });
    const touched = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(touched.version).toBe(0);
    expect(entries.filter((entry) => entry.level !== "debug")).toEqual([
      expect.objectContaining({ message: "processing restriction lifted" }),
      {
        level: "warn",
        message: "dead letter cannot be retried once the restriction was lifted",
        fields: {
          id: "gone",
          kind: "policy",
          handler: "order.gone",
          personId: "c-1",
          errorName: "DeadLetterNotRetriableError",
          errorCode: "DEAD_LETTER_NOT_RETRIABLE",
        },
      },
      {
        level: "warn",
        message: "dead letter failed again once the restriction was lifted",
        fields: {
          id: "broken",
          kind: "scheduled",
          handler: "BreakOrder",
          personId: "c-1",
          errorName: "ConfigurationError",
          errorCode: "INVALID_CONFIGURATION",
        },
      },
      {
        level: "info",
        message: "dead letter retried once the restriction was lifted",
        fields: { id: "later", kind: "scheduled", handler: "TouchOrder", personId: "c-1" },
      },
    ]);

    // Lifted again, nothing is left to retry, and the retried letter is left alone.
    await harness.storage.persons.restrict("c-1", harness.clock.now());
    await lift("c-1");
    await harness.dispatcher.runUntilIdle();
    expect(await harness.worker.runOnce()).toBe(1);
    expect((await deadLetterStore.get("later"))?.status).toBe("retried");
    expect((await deadLetterStore.get("broken"))?.attempts).toBe(2);
  });

  it("waits for every runner, where a deadline waits for the process runner alone", async () => {
    const { harness, lift } = await setup();
    const { storage, worker } = harness;
    await storage.persons.restrict("c-1", harness.clock.now());
    await lift("c-1");
    const payload = { process: "order.gone", aggregateId: "o-1", field: "timeout", at: "" };
    await storage.scheduler.schedule({
      dedupeKey: `process-deadline:${payload.process}:${payload.aggregateId}`,
      command: { type: PROCESS_DEADLINE_COMMAND, aggregateId: "o-1", payload },
      executeAt: harness.clock.now(),
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });
    await storage.checkpointStore.set(
      PROCESSES_SUBSCRIBER,
      await storage.eventStore.lastPosition(),
    );
    expect(await worker.runOnce()).toBe(2);
    // The deadline of a process no longer registered is cancelled when it runs.
    expect((await storage.scheduler.list()).map((entry) => entry.dedupeKey)).toEqual([
      "retry-restricted:c-1",
    ]);
    expect(worker.waitingDeadlines()).toBe(1);
  });

  it("runs the entry anyway once the runners have had their rounds", async () => {
    const { harness, lift } = await setup();
    await harness.storage.persons.restrict("c-1", harness.clock.now());
    await harness.storage.deadLetterStore.add(
      refused("one", "TouchOrder", "o-1", "c-1", "2026-01-01T00:00:00Z"),
    );
    await lift("c-1");
    for (let round = 0; round < DEADLINE_WAIT_ROUNDS; round += 1) {
      expect(await harness.worker.runOnce()).toBe(1);
    }
    expect((await harness.storage.deadLetterStore.get("one"))?.status).toBe("failed");
    expect(await harness.worker.runOnce()).toBe(1);
    expect((await harness.storage.deadLetterStore.get("one"))?.status).toBe("retried");
  });

  it("drops the entry without a letter when it keeps failing, telling the operator", async () => {
    const { harness, entries, lift } = await setup({
      runtime: { policies: { retry: { strategy: "none" } } },
    });
    await harness.storage.persons.restrict("c-1", harness.clock.now());
    await lift("c-1");
    await harness.dispatcher.runUntilIdle();
    harness.storage.deadLetterStore.listFailed = async () => {
      throw new Error("down");
    };
    expect(await harness.worker.runOnce()).toBe(1);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    expect(entries).toContainEqual({
      level: "error",
      message: "restricted dead letters could not be retried; retry them by hand",
      fields: expect.objectContaining({ personId: "c-1", attempts: 1, message: "down" }),
    });
  });

  it("skips a letter settled meanwhile, stops when the person is restricted again, and hands a letter refused for someone else to them", async () => {
    const { harness, entries } = await setup();
    const { deadLetterStore } = harness.storage;
    const retried: string[] = [];
    const failures = new Map<string, unknown>([
      ["settled", new DeadLetterSettledError({ id: "settled" })],
      ["theirs", new ProcessingRestrictedError("c-9")],
      ["again", new ProcessingRestrictedError("c-1")],
    ]);
    const retries = createRestrictedRetries({
      storage: harness.storage,
      retries: {
        retry: async (letter) => {
          retried.push(letter.id);
          const failure = failures.get(letter.id);
          if (failure !== undefined) throw failure;
        },
      },
      clock: harness.clock,
      logger: harness.logger,
    });
    const ids = ["settled", "ok", "theirs", "again", "never"];
    for (const [index, id] of ids.entries()) {
      await deadLetterStore.add(
        refused(id, "TouchOrder", `o-${id}`, "c-1", `2026-01-01T00:0${index}:00Z`),
      );
    }
    const unit = createUnitOfWork({ storage: harness.storage });
    let renewals = 0;
    await retries.retryAll({
      personId: "c-1",
      unit,
      beforeEach: async () => {
        renewals += 1;
      },
    });
    await unit.commit();
    expect(retried).toEqual(["settled", "ok", "theirs", "again"]);
    expect(renewals).toBe(4);
    expect(await deadLetterStore.get("theirs")).toMatchObject({
      person: "c-9",
      status: "failed",
      errorCode: "PROCESSING_RESTRICTED",
      attempts: 2,
    });
    expect(await deadLetterStore.get("again")).toMatchObject({ person: "c-1", attempts: 1 });
    expect(entries).toContainEqual({
      level: "info",
      message: "dead letters wait: the person is restricted again",
      fields: { id: "again", kind: "scheduled", handler: "TouchOrder", personId: "c-1" },
    });
    expect(
      (await deadLetterStore.listFailed({ person: "c-1", errorCode: "PROCESSING_RESTRICTED" })).map(
        ({ id }) => id,
      ),
    ).toEqual(["settled", "ok", "again", "never"]);
  });

  it("goes past a letter another retry settled first, and resolves", async () => {
    const { harness } = await setup();
    const retries = createRestrictedRetries({
      storage: harness.storage,
      retries: {
        retry: async () => {
          throw new DeadLetterSettledError({ id: "one" });
        },
      },
      clock: harness.clock,
      logger: harness.logger,
    });
    await harness.storage.deadLetterStore.add(
      refused("one", "TouchOrder", "o-1", "c-1", "2026-01-01T00:00:00Z"),
    );
    const unit = createUnitOfWork({ storage: harness.storage });
    await expect(
      retries.retryAll({ personId: "c-1", unit, beforeEach: async () => {} }),
    ).resolves.toBeUndefined();
  });

  it("leaves a letter that fails in a way worth retrying as it is, retries the rest, then rejects with that failure", async () => {
    const { harness, entries } = await setup();
    const { deadLetterStore } = harness.storage;
    const down = new Error("mail down");
    const retried: string[] = [];
    const retries = createRestrictedRetries({
      storage: harness.storage,
      retries: {
        retry: async (letter) => {
          retried.push(letter.id);
          if (letter.id === "flaky") throw down;
          await deadLetterStore.updateStatus(letter.id, "retried");
        },
      },
      clock: harness.clock,
      logger: harness.logger,
    });
    await deadLetterStore.add(refused("flaky", "TouchOrder", "o-1", "c-1", "2026-01-01T00:00:00Z"));
    await deadLetterStore.add(refused("fine", "TouchOrder", "o-2", "c-1", "2026-01-01T00:01:00Z"));
    const unit = createUnitOfWork({ storage: harness.storage });
    await expect(
      retries.retryAll({ personId: "c-1", unit, beforeEach: async () => {} }),
    ).rejects.toBe(down);
    expect(retried).toEqual(["flaky", "fine"]);
    expect(entries).toContainEqual({
      level: "warn",
      message: "dead letter retry failed once the restriction was lifted; will retry",
      fields: {
        id: "flaky",
        kind: "scheduled",
        handler: "TouchOrder",
        personId: "c-1",
        errorName: "Error",
      },
    });
    expect(await deadLetterStore.get("flaky")).toEqual({
      ...refused("flaky", "TouchOrder", "o-1", "c-1", "2026-01-01T00:00:00Z"),
      status: "failed",
    });
  });

  it("stops before the next letter when the entry's claim can no longer be renewed", async () => {
    const { harness } = await setup();
    const { deadLetterStore } = harness.storage;
    const retried: string[] = [];
    const retries = createRestrictedRetries({
      storage: harness.storage,
      retries: {
        retry: async (letter) => {
          retried.push(letter.id);
        },
      },
      clock: harness.clock,
      logger: harness.logger,
    });
    await deadLetterStore.add(refused("one", "TouchOrder", "o-1", "c-1", "2026-01-01T00:00:00Z"));
    await deadLetterStore.add(refused("two", "TouchOrder", "o-2", "c-1", "2026-01-01T00:01:00Z"));
    const lost = new Error("lost");
    let renewals = 0;
    const unit = createUnitOfWork({ storage: harness.storage });
    await expect(
      retries.retryAll({
        personId: "c-1",
        unit,
        beforeEach: async () => {
          renewals += 1;
          if (renewals > 1) throw lost;
        },
      }),
    ).rejects.toBe(lost);
    expect(retried).toEqual(["one"]);
  });

  it("leaves a letter the app cannot retry as it is", async () => {
    const { harness } = await setup();
    const { deadLetterStore } = harness.storage;
    const retries = createRestrictedRetries({
      storage: harness.storage,
      retries: {
        retry: async () => {
          throw new DeadLetterNotRetriableError("gone");
        },
      },
      clock: harness.clock,
      logger: harness.logger,
    });
    await deadLetterStore.add(refused("one", "TouchOrder", "o-1", "c-1", "2026-01-01T00:00:00Z"));
    const unit = createUnitOfWork({ storage: harness.storage });
    await retries.retryAll({ personId: "c-1", unit, beforeEach: async () => {} });
    await unit.commit();
    expect(await deadLetterStore.get("one")).toEqual({
      ...refused("one", "TouchOrder", "o-1", "c-1", "2026-01-01T00:00:00Z"),
      status: "failed",
    });
  });
});
