import { describe, expect, it } from "vitest";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { tracer } from "../telemetry.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import { advanceUntilWaiting, createRecordingLogger } from "../test-support.ts";
import {
  type CheckpointClaim,
  type ClaimFunction,
  checkpointedByStore,
  createCheckpointedSubscriber,
  type DeliveryOutcome,
  PartialBatchError,
  restsOn,
} from "./delivery.ts";
import { createDispatcher } from "./dispatcher.ts";

const setup = async (count: number) => {
  const { eventStore, checkpointStore } = await memory().createStorage();
  await eventStore.append({
    aggregateType: "order",
    aggregateId: "1",
    expectedVersion: 0,
    events: Array.from({ length: count }, (_, index) =>
      pendingEvent({ aggregateId: "1", version: index + 1 }),
    ),
  });
  const read = (afterPosition: number) => eventStore.readAll({ afterPosition, limit: 10 });
  return { eventStore, checkpointStore, read };
};

interface Transactions {
  readonly waits: boolean[];
  readonly rolledBack: unknown[];
  acquired: boolean;
}

const transactional = (
  checkpointStore: Awaited<ReturnType<typeof setup>>["checkpointStore"],
  name: string,
): { readonly claim: ClaimFunction<CheckpointClaim>; readonly transactions: Transactions } => {
  const transactions: Transactions = { waits: [], rolledBack: [], acquired: true };
  return {
    transactions,
    claim: async ({ wait, work }) => {
      transactions.waits.push(wait);
      if (!transactions.acquired) return { acquired: false };
      try {
        return {
          acquired: true,
          value: await work({
            get: () => checkpointStore.get(name),
            compareAndSet: (expected, position) =>
              checkpointStore.compareAndSet(name, expected, position),
          }),
        };
      } catch (error) {
        transactions.rolledBack.push(error);
        throw error;
      }
    },
  };
};

describe("createCheckpointedSubscriber", () => {
  it("advances only as far as the events the batch reports done", async () => {
    const { checkpointStore, read } = await setup(5);
    const { claim } = transactional(checkpointStore, "partial");
    const seen: number[][] = [];
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "partial",
      kind: "projection",
      position: () => checkpointStore.get("partial"),
      claim,
      process: async (events: readonly StoredEvent[]) => {
        seen.push(events.map((event) => event.position));
        return 2;
      },
      logger: silentLogger,
      errorText: "omit",
    });
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe(
      "advanced",
    );
    expect(await subscriber.position()).toBe(2);
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe(
      "advanced",
    );
    expect(seen).toEqual([
      [1, 2, 3, 4, 5],
      [3, 4, 5],
    ]);
    expect(await subscriber.position()).toBe(4);
  });

  it("reports busy without processing when another holder has the claim", async () => {
    const { checkpointStore, read } = await setup(1);
    const { claim, transactions } = transactional(checkpointStore, "held-elsewhere");
    transactions.acquired = false;
    let processed = 0;
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "held-elsewhere",
      kind: "projection",
      position: () => checkpointStore.get("held-elsewhere"),
      claim,
      process: async (events) => {
        processed += events.length;
        return events.length;
      },
      logger: silentLogger,
      errorText: "omit",
    });
    const telemetry = installFakeTelemetry();
    try {
      expect((await subscriber.deliver({ read, batchSize: 10, wait: false })).outcome).toBe("busy");
      expect(telemetry.spans.map((span) => span.attributes["bounda.outcome"])).toEqual(["busy"]);
    } finally {
      telemetry.restore();
    }
    expect(transactions.waits).toEqual([false]);
    expect(processed).toBe(0);
    expect(await subscriber.position()).toBe(0);
  });

  it("throws out of the claim when the batch is held or fails, so a transaction rolls back", async () => {
    const { checkpointStore, read } = await setup(2);
    const { claim, transactions } = transactional(checkpointStore, "undone");
    const outcomes: number[] = [0];
    const { logger, entries } = createRecordingLogger();
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "undone",
      kind: "projection",
      position: () => checkpointStore.get("undone"),
      claim,
      process: async () => {
        const next = outcomes.shift();
        if (next === undefined) throw new Error("boom");
        return next;
      },
      logger,
      errorText: "omit",
    });
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe("held");
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe("failed");
    expect(transactions.rolledBack).toHaveLength(2);
    expect(await subscriber.position()).toBe(0);
    expect(entries).toEqual([
      {
        level: "error",
        message: "subscriber failed; batch will be redelivered",
        fields: {
          subscriber: "undone",
          afterPosition: 0,
          failedPosition: 1,
          errorName: "Error",
          errorMessage: "boom",
          errorStack: expect.stringContaining("boom"),
        },
      },
    ]);
  });

  it("leaves a batch alone when the checkpoint moved before the claim was granted", async () => {
    const { checkpointStore, read } = await setup(3);
    const { claim, transactions } = transactional(checkpointStore, "stale");
    let processed = 0;
    const { logger, entries } = createRecordingLogger();
    const subscriber = createCheckpointedSubscriber<CheckpointClaim>({
      tracer,
      name: "stale",
      kind: "projection",
      position: () => checkpointStore.get("stale"),
      claim: async (args) => {
        await checkpointStore.set("stale", 2);
        return claim(args);
      },
      process: async (events) => {
        processed += events.length;
        return events.length;
      },
      logger,
      errorText: "omit",
    });
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe("moved");
    expect(processed).toBe(0);
    expect(transactions.rolledBack).toHaveLength(1);
    expect(await subscriber.position()).toBe(2);
    expect(entries).toEqual([
      {
        level: "warn",
        message: "checkpoint moved by someone else; batch will be redelivered from there",
        fields: { subscriber: "stale", afterPosition: 0, current: 2 },
      },
    ]);
  });

  it("commits the events before the one that failed on their own and says which one failed", async () => {
    const { checkpointStore, read } = await setup(4);
    const { claim, transactions } = transactional(checkpointStore, "poisoned");
    const seen: number[][] = [];
    const { logger, entries } = createRecordingLogger();
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "poisoned",
      kind: "projection",
      position: () => checkpointStore.get("poisoned"),
      claim,
      process: async (events) => {
        seen.push(events.map((event) => event.position));
        if (events.some((event) => event.position === 3)) {
          throw new PartialBatchError(2, new Error("poison"));
        }
        return events.length;
      },
      logger,
      errorText: "omit",
    });
    expect(await subscriber.deliver({ read, batchSize: 10, wait: true })).toEqual({
      outcome: "failed",
      failure: { position: 3, eventId: "order-1-3", eventType: "OrderPlaced", errorName: "Error" },
      event: expect.objectContaining({ id: "order-1-3", position: 3 }),
      error: expect.objectContaining({ message: "poison" }),
    });
    expect(seen).toEqual([
      [1, 2, 3, 4],
      [1, 2],
    ]);
    expect(transactions.rolledBack).toHaveLength(1);
    expect(await subscriber.position()).toBe(2);
    expect(entries).toEqual([
      {
        level: "error",
        message: "subscriber failed; batch will be redelivered",
        fields: {
          subscriber: "poisoned",
          afterPosition: 0,
          failedPosition: 3,
          errorName: "Error",
          errorMessage: "poison",
          errorStack: expect.stringContaining("poison"),
        },
      },
      {
        level: "info",
        message: "subscriber applied the events before the one that failed",
        fields: { subscriber: "poisoned", afterPosition: 0, through: 2 },
      },
    ]);
  });

  it("leaves the checkpoint where it was when the events before the failure fail too", async () => {
    const { checkpointStore, read } = await setup(3);
    const { claim } = transactional(checkpointStore, "shaky");
    const { logger, entries } = createRecordingLogger();
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "shaky",
      kind: "projection",
      position: () => checkpointStore.get("shaky"),
      claim,
      process: async (events) => {
        if (events.length === 3) throw new PartialBatchError(2, new Error("poison"));
        throw new Error("database gone");
      },
      logger,
      errorText: "omit",
    });
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe("failed");
    expect(await subscriber.position()).toBe(0);
    expect(entries.map(({ level, message }) => [level, message])).toEqual([
      ["error", "subscriber failed; batch will be redelivered"],
      ["error", "subscriber could not apply the events before the one that failed"],
    ]);
    expect(entries[1]?.fields).toMatchObject({
      subscriber: "shaky",
      errorMessage: "database gone",
    });
  });

  it("gives up on the events before the failure when another holder took the claim meanwhile", async () => {
    const { checkpointStore, read } = await setup(3);
    const { claim, transactions } = transactional(checkpointStore, "contended");
    const { logger, entries } = createRecordingLogger();
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "contended",
      kind: "projection",
      position: () => checkpointStore.get("contended"),
      claim,
      process: async () => {
        transactions.acquired = false;
        throw new PartialBatchError(2, new Error("poison"));
      },
      logger,
      errorText: "omit",
    });
    expect((await subscriber.deliver({ read, batchSize: 10, wait: false })).outcome).toBe("failed");
    expect(transactions.waits).toEqual([false, false]);
    expect(await subscriber.position()).toBe(0);
    expect(entries.map(({ message }) => message)).toEqual([
      "subscriber failed; batch will be redelivered",
    ]);
  });

  it("leaves the checkpoint to whoever moved it before the events before the failure were kept", async () => {
    const { checkpointStore, read } = await setup(3);
    const { claim } = transactional(checkpointStore, "overtaken");
    const { logger, entries } = createRecordingLogger();
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "overtaken",
      kind: "projection",
      position: () => checkpointStore.get("overtaken"),
      claim,
      process: async () => {
        await checkpointStore.set("overtaken", 3);
        throw new PartialBatchError(2, new Error("poison"));
      },
      logger,
      errorText: "omit",
    });
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe("failed");
    expect(await subscriber.position()).toBe(3);
    expect(entries.map(({ message }) => message)).toEqual([
      "subscriber failed; batch will be redelivered",
    ]);
  });

  it("names the error a batch that failed partway throws and keeps what caused it", () => {
    const cause = new Error("poison");
    const error = new PartialBatchError(2, cause);
    expect({
      name: error.name,
      message: error.message,
      cause: error.cause,
      done: error.done,
    }).toEqual({ name: "PartialBatchError", message: "poison", cause, done: 2 });
  });

  it("claims nothing more when the very first event of the batch failed", async () => {
    const { checkpointStore, read } = await setup(2);
    const { claim, transactions } = transactional(checkpointStore, "head");
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "head",
      kind: "projection",
      position: () => checkpointStore.get("head"),
      claim,
      process: async () => {
        throw new PartialBatchError(0, "not an error");
      },
      logger: silentLogger,
      errorText: "omit",
    });
    expect(await subscriber.deliver({ read, batchSize: 10, wait: true })).toEqual({
      outcome: "failed",
      failure: {
        position: 1,
        eventId: "order-1-1",
        eventType: "OrderPlaced",
        errorName: "string",
      },
      event: expect.objectContaining({ id: "order-1-1", position: 1 }),
      error: "not an error",
    });
    expect(transactions.waits).toEqual([true]);
  });

  it("reports idle without claiming when nothing follows the checkpoint", async () => {
    const { checkpointStore, read } = await setup(0);
    const { claim, transactions } = transactional(checkpointStore, "quiet");
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "quiet",
      kind: "projection",
      position: () => checkpointStore.get("quiet"),
      claim,
      process: async (events) => events.length,
      logger: silentLogger,
      errorText: "omit",
    });
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe("idle");
    expect(transactions.waits).toEqual([]);
  });
});

describe("restsOn", () => {
  const events = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ position: index + 1 }) as StoredEvent);
  const second = (event: StoredEvent) => event.position === 2;

  it("rests on a batch shorter than a read with no event it handles", () => {
    expect(restsOn({ handles: second, events: events(1), batchSize: 3 })).toBe(true);
    expect(restsOn({ handles: second, events: [], batchSize: 3 })).toBe(true);
  });

  it("never rests on an event it handles, on a full batch, or without knowing what it handles", () => {
    expect(restsOn({ handles: second, events: events(2), batchSize: 3 })).toBe(false);
    expect(restsOn({ handles: () => false, events: events(3), batchSize: 3 })).toBe(false);
    expect(restsOn({ handles: undefined, events: events(1), batchSize: 3 })).toBe(false);
  });
});

describe("a checkpointed subscriber that says what it handles", () => {
  const resting = async (count: number, handled: (position: number) => boolean) => {
    const { eventStore, checkpointStore, read } = await setup(count);
    const { claim, transactions } = transactional(checkpointStore, "picky");
    const seen: number[][] = [];
    const subscriber = createCheckpointedSubscriber({
      tracer,
      name: "picky",
      kind: "projection",
      position: () => checkpointStore.get("picky"),
      claim,
      process: async (events) => {
        seen.push(events.map((event) => event.position));
        return events.length;
      },
      handles: (event) => handled(event.position),
      logger: silentLogger,
      errorText: "omit",
    });
    return { eventStore, checkpointStore, read, transactions, seen, subscriber };
  };

  it("rests without claiming on events it does not handle, and takes them with the next it does", async () => {
    const { eventStore, checkpointStore, read, transactions, seen, subscriber } = await resting(
      3,
      (position) => position === 4,
    );
    expect(subscriber.handles).toBeDefined();
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe("idle");
    expect(transactions.waits).toEqual([]);
    expect(await checkpointStore.get("picky")).toBe(0);
    await eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 3,
      events: [pendingEvent({ aggregateId: "1", version: 4 })],
    });
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe(
      "advanced",
    );
    expect(seen).toEqual([[1, 2, 3, 4]]);
    expect(await checkpointStore.get("picky")).toBe(4);
  });

  it("moves past a full batch of events it does not handle", async () => {
    const { checkpointStore, read, seen, subscriber } = await resting(10, () => false);
    expect((await subscriber.deliver({ read, batchSize: 10, wait: true })).outcome).toBe(
      "advanced",
    );
    expect(seen).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
    expect(await checkpointStore.get("picky")).toBe(10);
  });

  it("keeps what it handles when the store wraps it", async () => {
    const { checkpointStore } = await setup(0);
    const handles = (event: StoredEvent) => event.position > 1;
    const wrapped = checkpointedByStore({
      tracer,
      subscriber: {
        name: "plain",
        kind: "policy",
        handles,
        process: async (events) => events.length,
      },
      checkpointStore,
      logger: silentLogger,
      errorText: "omit",
    });
    expect(wrapped.handles).toBe(handles);
    const bare = checkpointedByStore({
      tracer,
      subscriber: { name: "bare", kind: "policy", process: async (events) => events.length },
      checkpointStore,
      logger: silentLogger,
      errorText: "omit",
    });
    expect(bare.handles).toBeUndefined();
  });
});

describe("the dispatcher with a subscriber at rest", () => {
  const start = async (count: number, handled: (position: number) => boolean) => {
    const { eventStore, checkpointStore } = await setup(count);
    const writes: number[] = [];
    const dispatcher = createDispatcher({
      tracer,
      clock: createFixedClock(),
      eventStore,
      checkpointStore,
      subscribers: [
        {
          name: "picky",
          kind: "policy",
          handles: (event) => handled(event.position),
          process: async (events) => {
            writes.push(events.length);
            return events.length;
          },
        },
        { name: "eager", kind: "policy", process: async (events) => events.length },
      ],
      batchSize: 4,
      pollIntervalMs: 100,
      logger: silentLogger,
      errorText: "omit",
    });
    return { dispatcher, checkpointStore, writes };
  };

  it("reports it at the head with no lag, while its checkpoint stays where it was", async () => {
    const { dispatcher, checkpointStore, writes } = await start(3, () => false);
    await dispatcher.runUntilIdle();
    expect(writes).toEqual([]);
    expect(await checkpointStore.get("picky")).toBe(0);
    expect(await dispatcher.positionOf("picky")).toBe(3);
    expect(await dispatcher.getLag()).toEqual({
      lastPosition: 3,
      maxLag: 0,
      subscribers: [
        { subscriber: "picky", position: 3, lag: 0 },
        { subscriber: "eager", position: 3, lag: 0 },
      ],
    });
  });

  it("reports the lag behind an event it handles, and behind a full batch it does not", async () => {
    const handling = await start(3, (position) => position === 2);
    expect((await handling.dispatcher.getLag()).subscribers[0]).toEqual({
      subscriber: "picky",
      position: 0,
      lag: 3,
    });
    const full = await start(5, () => false);
    expect(await full.dispatcher.positionOf("picky")).toBe(0);
    await full.dispatcher.runUntilIdle();
    expect(full.writes).toEqual([4]);
    expect(await full.dispatcher.positionOf("picky")).toBe(5);
    expect((await full.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("reads the stream once for the subscribers at one checkpoint, and not for one at the head or one that handles everything", async () => {
    const { eventStore, checkpointStore } = await setup(3);
    const reads: number[] = [];
    const subscriber = (name: string) => ({
      name,
      kind: "policy" as const,
      handles: () => false,
      process: async (events: readonly StoredEvent[]) => events.length,
    });
    const dispatcher = createDispatcher({
      tracer,
      clock: createFixedClock(),
      eventStore: {
        ...eventStore,
        readAll: (args) => {
          reads.push(args.afterPosition);
          return eventStore.readAll(args);
        },
      },
      checkpointStore,
      subscribers: [
        subscriber("first"),
        subscriber("second"),
        subscriber("done"),
        { name: "eager", kind: "policy", process: async (events) => events.length },
      ],
      batchSize: 4,
      pollIntervalMs: 100,
      logger: silentLogger,
      errorText: "omit",
    });
    await checkpointStore.set("done", 3);
    await checkpointStore.set("eager", 1);
    expect((await dispatcher.getLag()).maxLag).toBe(2);
    expect(reads).toEqual([0]);
  });

  it("answers the checkpoint of a subscriber it does not run", async () => {
    const { dispatcher, checkpointStore } = await start(3, () => false);
    await checkpointStore.set("elsewhere", 2);
    expect(await dispatcher.positionOf("elsewhere")).toBe(2);
  });
});

describe("the dispatcher with a checkpointed subscriber", () => {
  it("skips it in background passes while another holder has it and waits for it when awaited", async () => {
    const { eventStore, checkpointStore } = await setup(2);
    const { claim, transactions } = transactional(checkpointStore, "shared");
    transactions.acquired = false;
    const outcomes: DeliveryOutcome[] = [];
    const inner = createCheckpointedSubscriber({
      tracer,
      name: "shared",
      kind: "projection",
      position: () => checkpointStore.get("shared"),
      claim,
      process: async (events) => events.length,
      logger: silentLogger,
      errorText: "omit",
    });
    const clock = createFixedClock();
    const dispatcher = createDispatcher({
      tracer,
      clock,
      eventStore,
      checkpointStore,
      subscribers: [
        {
          ...inner,
          deliver: async (args) => {
            const delivery = await inner.deliver(args);
            outcomes.push(delivery.outcome);
            return delivery;
          },
        },
      ],
      batchSize: 10,
      pollIntervalMs: 100,
      logger: silentLogger,
      errorText: "omit",
    });
    dispatcher.start();
    await advanceUntilWaiting(clock, 100);
    await dispatcher.stop();
    expect(outcomes).toEqual(["busy"]);
    expect(transactions.waits).toEqual([false]);

    transactions.acquired = true;
    expect(await dispatcher.processOnce()).toBe(true);
    await dispatcher.runUntilIdle();
    await dispatcher.catchUp("projection");
    expect(transactions.waits).toEqual([false, true]);
    expect(outcomes).toEqual(["busy", "advanced", "idle", "idle"]);
    await checkpointStore.set("shared", 0);
    await dispatcher.runUntilIdle();
    await checkpointStore.set("shared", 0);
    await dispatcher.catchUp("projection");
    expect(transactions.waits).toEqual([false, true, true, true]);
    expect((await dispatcher.getLag()).subscribers).toEqual([
      { subscriber: "shared", position: 2, lag: 0 },
    ]);
  });
});
