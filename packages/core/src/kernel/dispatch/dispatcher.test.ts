import { describe, expect, it, vi } from "vitest";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import { createDispatcher, type Subscriber } from "./dispatcher.ts";

const storage = () => memory().createStorage({ logger: silentLogger });

const appendMany = async (
  eventStore: Awaited<ReturnType<typeof storage>>["eventStore"],
  count: number,
) => {
  await eventStore.append({
    aggregateType: "order",
    aggregateId: "1",
    expectedVersion: 0,
    events: Array.from({ length: count }, (_, index) =>
      pendingEvent({ aggregateId: "1", version: index + 1 }),
    ),
  });
};

const recorder = (
  name: string,
  kind: Subscriber["kind"] = "projection",
): Subscriber & { readonly seen: number[][] } => {
  const seen: number[][] = [];
  return {
    name,
    kind,
    seen,
    process: async (events) => {
      seen.push(events.map((event) => event.position));
      return true;
    },
  };
};

describe("createDispatcher", () => {
  it("delivers batches per subscriber in order and checkpoints after each", async () => {
    const { eventStore, checkpointStore } = await storage();
    await appendMany(eventStore, 5);
    const a = recorder("a");
    const b = recorder("b");
    const dispatcher = createDispatcher({
      eventStore,
      checkpointStore,
      subscribers: [a, b],
      batchSize: 2,
      pollIntervalMs: 1_000,
      logger: silentLogger,
    });

    expect(await dispatcher.processOnce()).toBe(true);
    expect(a.seen).toEqual([[1, 2]]);
    expect(b.seen).toEqual([[1, 2]]);
    expect(await checkpointStore.get("a")).toBe(2);

    await dispatcher.processUntilIdle();
    expect(a.seen).toEqual([[1, 2], [3, 4], [5]]);
    expect(await checkpointStore.get("b")).toBe(5);
    expect(await dispatcher.processOnce()).toBe(false);
    expect(await dispatcher.getLag()).toEqual({
      lastPosition: 5,
      subscribers: [
        { subscriber: "a", position: 5, lag: 0 },
        { subscriber: "b", position: 5, lag: 0 },
      ],
      maxLag: 0,
    });
  });

  it("catches up the subscribers of one kind and leaves the others where they were", async () => {
    const { eventStore, checkpointStore } = await storage();
    await appendMany(eventStore, 3);
    const projection = recorder("projection:orders");
    const policies = recorder("policies", "policy");
    const dispatcher = createDispatcher({
      eventStore,
      checkpointStore,
      subscribers: [projection, policies],
      batchSize: 2,
      pollIntervalMs: 1_000,
      logger: silentLogger,
    });

    await dispatcher.catchUp("projection");
    expect(projection.seen).toEqual([[1, 2], [3]]);
    expect(policies.seen).toEqual([]);
    expect(await checkpointStore.get("projection:orders")).toBe(3);
    expect(await checkpointStore.get("policies")).toBe(0);

    await dispatcher.catchUp("process");
    expect(policies.seen).toEqual([]);
    expect(await dispatcher.processOnce()).toBe(true);
    expect(policies.seen).toEqual([[1, 2]]);
  });

  it("holds the checkpoint when a subscriber throws or declines, and redelivers", async () => {
    const { eventStore, checkpointStore } = await storage();
    await appendMany(eventStore, 2);
    let failures = 2;
    const flaky: Subscriber = {
      name: "flaky",
      kind: "projection",
      process: async () => {
        if (failures > 0) {
          failures -= 1;
          if (failures === 1) throw new Error("boom");
          return false;
        }
        return true;
      },
    };
    const { logger, entries } = createRecordingLogger();
    const dispatcher = createDispatcher({
      eventStore,
      checkpointStore,
      subscribers: [flaky],
      batchSize: 10,
      pollIntervalMs: 1_000,
      logger,
    });
    expect(await dispatcher.processOnce()).toBe(false);
    expect(await checkpointStore.get("flaky")).toBe(0);
    expect(entries).toEqual([
      {
        level: "error",
        message: "subscriber failed; batch will be redelivered",
        fields: {
          subscriber: "flaky",
          afterPosition: 0,
          message: "boom",
          stack: expect.stringContaining("boom"),
        },
      },
    ]);
    expect(await dispatcher.processOnce()).toBe(false);
    expect(await checkpointStore.get("flaky")).toBe(0);
    expect(await dispatcher.processOnce()).toBe(true);
    expect(await checkpointStore.get("flaky")).toBe(2);
    expect((await dispatcher.getLag()).maxLag).toBe(0);
  });

  it("never runs two passes at once, whoever triggers them", async () => {
    const { eventStore, checkpointStore } = await storage();
    await appendMany(eventStore, 3);
    let inside = 0;
    let overlap = false;
    const slow: Subscriber = {
      name: "slow",
      kind: "projection",
      process: async () => {
        inside += 1;
        overlap = overlap || inside > 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        inside -= 1;
        return true;
      },
    };
    const dispatcher = createDispatcher({
      eventStore,
      checkpointStore,
      subscribers: [slow],
      batchSize: 1,
      pollIntervalMs: 1,
      logger: silentLogger,
    });
    dispatcher.start();
    dispatcher.start();
    await Promise.all([
      dispatcher.processUntilIdle(),
      dispatcher.processOnce(),
      dispatcher.processUntilIdle(),
    ]);
    await dispatcher.stop();
    expect(overlap).toBe(false);
    expect(await checkpointStore.get("slow")).toBe(3);
  });

  it("polls in the background until stopped", async () => {
    const { eventStore, checkpointStore } = await storage();
    const seen: StoredEvent[] = [];
    const dispatcher = createDispatcher({
      eventStore,
      checkpointStore,
      subscribers: [
        {
          name: "bg",
          kind: "projection",
          process: async (events) => {
            seen.push(...events);
            return true;
          },
        },
      ],
      batchSize: 10,
      pollIntervalMs: 2,
      logger: silentLogger,
    });
    dispatcher.start();
    await appendMany(eventStore, 2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await dispatcher.stop();
    expect(seen.map((event) => event.position)).toEqual([1, 2]);
    expect((await dispatcher.getLag()).lastPosition).toBe(2);
  });

  it("reports how far behind the head each subscriber is", async () => {
    const { eventStore, checkpointStore } = await storage();
    await appendMany(eventStore, 5);
    await checkpointStore.set("b", 3);
    const dispatcher = createDispatcher({
      eventStore,
      checkpointStore,
      subscribers: [recorder("a"), recorder("b")],
      batchSize: 10,
      pollIntervalMs: 1_000,
      logger: silentLogger,
    });
    expect(await dispatcher.getLag()).toEqual({
      lastPosition: 5,
      subscribers: [
        { subscriber: "a", position: 0, lag: 5 },
        { subscriber: "b", position: 3, lag: 2 },
      ],
      maxLag: 5,
    });
  });

  it("arms one timer per interval, re-arms after each pass and leaves nothing behind on stop", async () => {
    vi.useFakeTimers();
    try {
      const { eventStore, checkpointStore } = await storage();
      let release: () => void = () => undefined;
      let passes = 0;
      const gated: Subscriber = {
        name: "gated",
        kind: "projection",
        process: async () => {
          passes += 1;
          if (passes === 2)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return true;
        },
      };
      const dispatcher = createDispatcher({
        eventStore,
        checkpointStore,
        subscribers: [gated],
        batchSize: 1,
        pollIntervalMs: 100,
        logger: silentLogger,
      });
      await appendMany(eventStore, 3);
      dispatcher.start();
      dispatcher.start();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(passes).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(passes).toBe(2);
      expect(vi.getTimerCount()).toBe(0);

      const stopping = dispatcher.stop();
      release();
      await stopping;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(passes).toBe(2);
      expect(await checkpointStore.get("gated")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failing pass and keeps polling", async () => {
    vi.useFakeTimers();
    try {
      const { eventStore, checkpointStore } = await storage();
      const original = checkpointStore.get.bind(checkpointStore);
      let failures = 1;
      checkpointStore.get = async (subscriber) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("checkpoints unavailable");
        }
        return original(subscriber);
      };
      const { logger, entries } = createRecordingLogger();
      const a = recorder("a");
      const dispatcher = createDispatcher({
        eventStore,
        checkpointStore,
        subscribers: [a],
        batchSize: 10,
        pollIntervalMs: 100,
        logger,
      });
      await appendMany(eventStore, 1);
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(entries).toEqual([
        {
          level: "error",
          message: "dispatcher pass failed",
          fields: { message: "checkpoints unavailable", stack: expect.any(String) },
        },
      ]);
      await vi.advanceTimersByTimeAsync(100);
      expect(a.seen).toEqual([[1]]);
      await dispatcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
