import { SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import { advanceUntilWaiting, createRecordingLogger, eventually } from "../test-support.ts";
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
      clock: createFixedClock(),
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
      clock: createFixedClock(),
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
      clock: createFixedClock(),
      eventStore,
      checkpointStore,
      subscribers: [flaky],
      batchSize: 10,
      pollIntervalMs: 1_000,
      logger,
    });
    const telemetry = installFakeTelemetry();
    try {
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
      expect(telemetry.spans.map((span) => span.attributes["bounda.outcome"])).toEqual([
        "failed",
        "held",
        "advanced",
      ]);
      expect(telemetry.spans[0]?.status.code).toBe(SpanStatusCode.UNSET);
    } finally {
      telemetry.restore();
    }
  });

  it("leaves a checkpoint alone when someone else moved it during the batch", async () => {
    const { eventStore, checkpointStore } = await storage();
    await appendMany(eventStore, 5);
    await checkpointStore.set("orders", 2);
    const seen: number[][] = [];
    const orders: Subscriber = {
      name: "orders",
      kind: "projection",
      process: async (events) => {
        seen.push(events.map((event) => event.position));
        if (seen.length === 1) await checkpointStore.set("orders", 0);
        return true;
      },
    };
    const { logger, entries } = createRecordingLogger();
    const dispatcher = createDispatcher({
      clock: createFixedClock(),
      eventStore,
      checkpointStore,
      subscribers: [orders],
      batchSize: 2,
      pollIntervalMs: 1_000,
      logger,
    });

    const telemetry = installFakeTelemetry();
    try {
      expect(await dispatcher.processOnce()).toBe(true);
      expect(telemetry.spans).toEqual([
        expect.objectContaining({
          name: "bounda.subscriber orders",
          attributes: {
            "bounda.subscriber": "orders",
            "bounda.subscriber.kind": "projection",
            "bounda.position.after": 2,
            "bounda.event.count": 2,
            "bounda.outcome": "moved",
          },
          ended: true,
        }),
      ]);
    } finally {
      telemetry.restore();
    }
    expect(seen).toEqual([[3, 4]]);
    expect(await checkpointStore.get("orders")).toBe(0);
    expect(entries).toEqual([
      {
        level: "warn",
        message: "checkpoint moved by someone else; batch will be redelivered from there",
        fields: { subscriber: "orders", afterPosition: 2, current: 0 },
      },
    ]);

    await dispatcher.processUntilIdle();
    expect(seen).toEqual([[3, 4], [1, 2], [3, 4], [5]]);
    expect(await checkpointStore.get("orders")).toBe(5);
    expect(entries).toHaveLength(1);
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
    const clock = createFixedClock();
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [slow],
      batchSize: 1,
      pollIntervalMs: 1,
      logger: silentLogger,
    });
    dispatcher.start();
    dispatcher.start();
    const manual = Promise.all([
      dispatcher.processUntilIdle(),
      dispatcher.processOnce(),
      dispatcher.processUntilIdle(),
    ]);
    clock.advance(1);
    await manual;
    await eventually(() => expect(clock.pending()).toBe(1));
    await dispatcher.stop();
    expect(overlap).toBe(false);
    expect(await checkpointStore.get("slow")).toBe(3);
  });

  it("polls in the background until stopped", async () => {
    const { eventStore, checkpointStore } = await storage();
    const clock = createFixedClock();
    const seen: StoredEvent[] = [];
    const dispatcher = createDispatcher({
      clock,
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
    await advanceUntilWaiting(clock, 2);
    expect(seen.map((event) => event.position)).toEqual([1, 2]);
    expect((await dispatcher.getLag()).lastPosition).toBe(2);
    await dispatcher.stop();
    expect(clock.pending()).toBe(0);
  });

  it("reports how far behind the head each subscriber is", async () => {
    const { eventStore, checkpointStore } = await storage();
    await appendMany(eventStore, 5);
    await checkpointStore.set("b", 3);
    const dispatcher = createDispatcher({
      clock: createFixedClock(),
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
    const { eventStore, checkpointStore } = await storage();
    const clock = createFixedClock();
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
      clock,
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
    expect(clock.pending()).toBe(1);

    await advanceUntilWaiting(clock, 100);
    expect(passes).toBe(1);

    clock.advance(100);
    await eventually(() => expect(passes).toBe(2));
    expect(clock.pending()).toBe(0);

    const stopping = dispatcher.stop();
    release();
    await stopping;
    expect(clock.pending()).toBe(0);
    clock.advance(1_000);
    expect(passes).toBe(2);
    expect(await checkpointStore.get("gated")).toBe(2);
  });

  it("reports a failing pass and keeps polling", async () => {
    const { eventStore, checkpointStore } = await storage();
    const clock = createFixedClock();
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
      clock,
      eventStore,
      checkpointStore,
      subscribers: [a],
      batchSize: 10,
      pollIntervalMs: 100,
      logger,
    });
    await appendMany(eventStore, 1);
    dispatcher.start();
    await advanceUntilWaiting(clock, 100);
    expect(entries).toEqual([
      {
        level: "error",
        message: "dispatcher pass failed",
        fields: { message: "checkpoints unavailable", stack: expect.any(String) },
      },
    ]);
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([[1]]);
    await dispatcher.stop();
  });

  it("passes as soon as the storage notifies and stretches the timer while idle", async () => {
    const adapter = memory();
    const { eventStore, checkpointStore, notifier } = await adapter.createStorage({
      logger: silentLogger,
    });
    const clock = createFixedClock();
    const a = recorder("a");
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [a],
      batchSize: 10,
      pollIntervalMs: 100,
      idleIntervalMs: 30_000,
      ...(notifier === undefined ? {} : { notifier }),
      logger: silentLogger,
    });
    dispatcher.start();
    expect(clock.pending()).toBe(1);

    await appendMany(eventStore, 2);
    await eventually(() => expect(a.seen).toEqual([[1, 2]]));
    await eventually(() => expect(clock.pending()).toBe(1));

    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([[1, 2]]);
    await advanceUntilWaiting(clock, 29_900);
    expect(a.seen).toEqual([[1, 2]]);

    await eventStore.append({
      aggregateType: "order",
      aggregateId: "2",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "2", version: 1 })],
    });
    await eventually(() => expect(a.seen).toEqual([[1, 2], [3]]));

    await dispatcher.stop();
    expect(clock.pending()).toBe(0);
    await eventStore.append({
      aggregateType: "order",
      aggregateId: "3",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "3", version: 1 })],
    });
    clock.advance(60_000);
    expect(a.seen).toEqual([[1, 2], [3]]);
  });

  it("keeps polling at the poll interval while passes find events, and idles after", async () => {
    const adapter = memory();
    const { eventStore, checkpointStore, notifier } = await adapter.createStorage({
      logger: silentLogger,
    });
    await appendMany(eventStore, 3);
    const clock = createFixedClock();
    const a = recorder("a");
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [a],
      batchSize: 1,
      pollIntervalMs: 100,
      idleIntervalMs: 30_000,
      ...(notifier === undefined ? {} : { notifier }),
      logger: silentLogger,
    });
    dispatcher.start();
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([[1]]);
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([[1], [2]]);
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([[1], [2], [3]]);
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toHaveLength(3);
    await advanceUntilWaiting(clock, 29_800);
    expect(a.seen).toHaveLength(3);
    await dispatcher.stop();
  });

  it("runs one more pass after the one in flight when notifications arrive meanwhile", async () => {
    const adapter = memory();
    const {
      eventStore: rawStore,
      checkpointStore,
      notifier,
    } = await adapter.createStorage({ logger: silentLogger });
    let reads = 0;
    const eventStore = {
      ...rawStore,
      readAll: (args: Parameters<typeof rawStore.readAll>[0]) => {
        reads += 1;
        return rawStore.readAll(args);
      },
    };
    let release: () => void = () => undefined;
    const seen: number[][] = [];
    const gated: Subscriber = {
      name: "gated",
      kind: "projection",
      process: async (events) => {
        seen.push(events.map((event) => event.position));
        if (seen.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return true;
      },
    };
    const clock = createFixedClock();
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [gated],
      batchSize: 10,
      pollIntervalMs: 100,
      idleIntervalMs: 30_000,
      ...(notifier === undefined ? {} : { notifier }),
      logger: silentLogger,
    });
    dispatcher.start();
    await appendMany(eventStore, 1);
    await eventually(() => expect(seen).toEqual([[1]]));
    expect(clock.pending()).toBe(0);

    for (const aggregateId of ["2", "3"]) {
      await eventStore.append({
        aggregateType: "order",
        aggregateId,
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId, version: 1 })],
      });
    }
    expect(seen).toEqual([[1]]);
    expect(reads).toBe(1);
    release();
    await eventually(() => expect(clock.pending()).toBe(1));
    expect(seen).toEqual([[1], [2, 3]]);
    expect(reads).toBe(2);
    await dispatcher.stop();
  });

  it("falls back to polling when subscribing to notifications fails", async () => {
    const { eventStore, checkpointStore } = await storage();
    const clock = createFixedClock();
    const { logger, entries } = createRecordingLogger();
    const a = recorder("a");
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [a],
      batchSize: 10,
      pollIntervalMs: 100,
      idleIntervalMs: 30_000,
      notifier: {
        subscribe: async () => {
          throw new Error("no LISTEN for you");
        },
      },
      logger,
    });
    dispatcher.start();
    await eventually(() =>
      expect(entries).toEqual([
        {
          level: "error",
          message: "dispatcher could not subscribe to notifications; polling",
          fields: { message: "no LISTEN for you", stack: expect.any(String) },
        },
      ]),
    );
    await appendMany(eventStore, 1);
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([[1]]);
    await dispatcher.stop();
  });

  it("never idles without a notifier, whatever idleIntervalMs says", async () => {
    const { eventStore, checkpointStore } = await storage();
    const clock = createFixedClock();
    const a = recorder("a");
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [a],
      batchSize: 10,
      pollIntervalMs: 100,
      idleIntervalMs: 30_000,
      logger: silentLogger,
    });
    dispatcher.start();
    await advanceUntilWaiting(clock, 100);
    await advanceUntilWaiting(clock, 100);
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([]);
    await appendMany(eventStore, 1);
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([[1]]);
    await dispatcher.stop();
  });

  it("retries at the poll interval after a failed pass, even with a notifier", async () => {
    const adapter = memory();
    const { eventStore, checkpointStore, notifier } = await adapter.createStorage({
      logger: silentLogger,
    });
    const original = checkpointStore.get.bind(checkpointStore);
    let failures = 1;
    checkpointStore.get = async (subscriber) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("checkpoints unavailable");
      }
      return original(subscriber);
    };
    const clock = createFixedClock();
    const a = recorder("a");
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [a],
      batchSize: 10,
      pollIntervalMs: 100,
      idleIntervalMs: 30_000,
      ...(notifier === undefined ? {} : { notifier }),
      logger: silentLogger,
    });
    await appendMany(eventStore, 1);
    dispatcher.start();
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([]);
    await advanceUntilWaiting(clock, 100);
    expect(a.seen).toEqual([[1]]);
    await dispatcher.stop();
  });

  it("ignores a notification that arrives after it stopped", async () => {
    const { eventStore, checkpointStore } = await storage();
    const clock = createFixedClock();
    let listener: ((position?: number) => void) | undefined;
    const a = recorder("a");
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [a],
      batchSize: 10,
      pollIntervalMs: 100,
      idleIntervalMs: 30_000,
      notifier: {
        subscribe: async (next) => {
          listener = next;
          return async () => undefined;
        },
      },
      logger: silentLogger,
    });
    dispatcher.start();
    await dispatcher.stop();
    await appendMany(eventStore, 1);
    listener?.(1);
    clock.advance(1_000);
    expect(a.seen).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
