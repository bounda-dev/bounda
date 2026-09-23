import { describe, expect, it } from "vitest";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import { advanceUntilWaiting, createRecordingLogger } from "../test-support.ts";
import {
  type CheckpointClaim,
  type ClaimFunction,
  createCheckpointedSubscriber,
  type DeliveryOutcome,
} from "./delivery.ts";
import { createDispatcher } from "./dispatcher.ts";

const setup = async (count: number) => {
  const { eventStore, checkpointStore } = await memory().createStorage({ logger: silentLogger });
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
      name: "partial",
      kind: "projection",
      position: () => checkpointStore.get("partial"),
      claim,
      process: async (events: readonly StoredEvent[]) => {
        seen.push(events.map((event) => event.position));
        return 2;
      },
      logger: silentLogger,
    });
    expect(await subscriber.deliver({ read, wait: true })).toBe("advanced");
    expect(await subscriber.position()).toBe(2);
    expect(await subscriber.deliver({ read, wait: true })).toBe("advanced");
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
      name: "held-elsewhere",
      kind: "projection",
      position: () => checkpointStore.get("held-elsewhere"),
      claim,
      process: async (events) => {
        processed += events.length;
        return events.length;
      },
      logger: silentLogger,
    });
    const telemetry = installFakeTelemetry();
    try {
      expect(await subscriber.deliver({ read, wait: false })).toBe("busy");
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
    });
    expect(await subscriber.deliver({ read, wait: true })).toBe("held");
    expect(await subscriber.deliver({ read, wait: true })).toBe("failed");
    expect(transactions.rolledBack).toHaveLength(2);
    expect(await subscriber.position()).toBe(0);
    expect(entries).toEqual([
      {
        level: "error",
        message: "subscriber failed; batch will be redelivered",
        fields: {
          subscriber: "undone",
          afterPosition: 0,
          message: "boom",
          stack: expect.stringContaining("boom"),
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
    });
    expect(await subscriber.deliver({ read, wait: true })).toBe("moved");
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

  it("reports idle without claiming when nothing follows the checkpoint", async () => {
    const { checkpointStore, read } = await setup(0);
    const { claim, transactions } = transactional(checkpointStore, "quiet");
    const subscriber = createCheckpointedSubscriber({
      name: "quiet",
      kind: "projection",
      position: () => checkpointStore.get("quiet"),
      claim,
      process: async (events) => events.length,
      logger: silentLogger,
    });
    expect(await subscriber.deliver({ read, wait: true })).toBe("idle");
    expect(transactions.waits).toEqual([]);
  });
});

describe("the dispatcher with a checkpointed subscriber", () => {
  it("skips it in background passes while another holder has it and waits for it when awaited", async () => {
    const { eventStore, checkpointStore } = await setup(2);
    const { claim, transactions } = transactional(checkpointStore, "shared");
    transactions.acquired = false;
    const outcomes: DeliveryOutcome[] = [];
    const inner = createCheckpointedSubscriber({
      name: "shared",
      kind: "projection",
      position: () => checkpointStore.get("shared"),
      claim,
      process: async (events) => events.length,
      logger: silentLogger,
    });
    const clock = createFixedClock();
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [
        {
          ...inner,
          deliver: async (args) => {
            const outcome = await inner.deliver(args);
            outcomes.push(outcome);
            return outcome;
          },
        },
      ],
      batchSize: 10,
      pollIntervalMs: 100,
      logger: silentLogger,
    });
    dispatcher.start();
    await advanceUntilWaiting(clock, 100);
    await dispatcher.stop();
    expect(outcomes).toEqual(["busy"]);
    expect(transactions.waits).toEqual([false]);

    transactions.acquired = true;
    expect(await dispatcher.processOnce()).toBe(true);
    await dispatcher.processUntilIdle();
    await dispatcher.catchUp("projection");
    expect(transactions.waits).toEqual([false, true]);
    expect(outcomes).toEqual(["busy", "advanced", "idle", "idle"]);
    await checkpointStore.set("shared", 0);
    await dispatcher.processUntilIdle();
    await checkpointStore.set("shared", 0);
    await dispatcher.catchUp("projection");
    expect(transactions.waits).toEqual([false, true, true, true]);
    expect((await dispatcher.getLag()).subscribers).toEqual([
      { subscriber: "shared", position: 2, lag: 0 },
    ]);
  });
});
