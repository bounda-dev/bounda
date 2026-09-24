import { describe, expect, it } from "vitest";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { advanceUntilWaiting, eventually } from "../test-support.ts";
import type { CheckpointedSubscriber, Delivery, DeliveryFailure } from "./delivery.ts";
import { createDispatcher, type Subscriber } from "./dispatcher.ts";

const failure: DeliveryFailure = {
  position: 1,
  eventId: "order-1-1",
  eventType: "OrderPlaced",
  message: "boom",
};
const failed: Delivery = { outcome: "failed", failure };

interface Scripted extends CheckpointedSubscriber {
  readonly deliveries: number;
}

const scripted = (name: string, script: Delivery[]): Scripted => {
  let deliveries = 0;
  return {
    name,
    kind: "projection",
    position: async () => 0,
    deliver: async () => {
      deliveries += 1;
      return script.shift() ?? { outcome: "idle" };
    },
    get deliveries() {
      return deliveries;
    },
  };
};

const setUp = async (subscribers: readonly (Subscriber | CheckpointedSubscriber)[]) => {
  const { eventStore, checkpointStore } = await memory().createStorage({ logger: silentLogger });
  const clock = createFixedClock();
  const dispatcher = createDispatcher({
    clock,
    eventStore,
    checkpointStore,
    subscribers,
    batchSize: 10,
    pollIntervalMs: 100,
    backoff: { baseDelayMs: 1_000, maxDelayMs: 4_000 },
    logger: silentLogger,
  });
  return { eventStore, checkpointStore, clock, dispatcher };
};

const failingOf = async (
  dispatcher: Awaited<ReturnType<typeof setUp>>["dispatcher"],
  subscriber: string,
) => (await dispatcher.getLag()).subscribers.find((lag) => lag.subscriber === subscriber)?.failing;

describe("the dispatcher's backoff", () => {
  it("leaves a failing subscriber alone for longer after each failure, up to the maximum", async () => {
    const poisoned = scripted(
      "projection:poisoned",
      Array.from({ length: 5 }, () => failed),
    );
    const { clock, dispatcher } = await setUp([poisoned]);
    const start = clock.now().getTime();
    dispatcher.start();
    const attemptsAt: number[] = [];
    let seen = 0;
    for (let elapsed = 0; elapsed < 12_000; elapsed += 100) {
      await advanceUntilWaiting(clock, 100);
      if (poisoned.deliveries > seen) {
        seen = poisoned.deliveries;
        attemptsAt.push(clock.now().getTime() - start);
      }
    }
    await dispatcher.stop();
    expect(attemptsAt).toEqual([100, 1_100, 3_100, 7_100, 11_100]);
  });

  it("says what a subscriber is stuck on, since when and when it is tried again, until it recovers", async () => {
    const poisoned = scripted("projection:poisoned", [failed, failed, { outcome: "advanced" }]);
    const { clock, dispatcher } = await setUp([poisoned]);
    const at = (offset: number) => new Date(clock.now().getTime() + offset).toISOString();
    const since = at(0);
    await dispatcher.processOnce();
    clock.advance(500);
    await dispatcher.processOnce();
    expect(await failingOf(dispatcher, "projection:poisoned")).toEqual({
      ...failure,
      attempts: 2,
      since,
      retryAt: at(2_000),
    });
    await dispatcher.processOnce();
    expect(await failingOf(dispatcher, "projection:poisoned")).toBeUndefined();
  });

  it("keeps a failure through a delivery that is held or busy and forgets it once idle", async () => {
    const poisoned = scripted("projection:poisoned", [
      failed,
      { outcome: "held" },
      { outcome: "busy" },
      { outcome: "idle" },
    ]);
    const { dispatcher } = await setUp([poisoned]);
    const failingAfterEach: boolean[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      await dispatcher.processOnce();
      failingAfterEach.push((await failingOf(dispatcher, "projection:poisoned")) !== undefined);
    }
    expect(failingAfterEach).toEqual([true, true, true, false]);
  });

  it("retries every failing subscriber at once when another one recovers", async () => {
    const poisoned = scripted("projection:poisoned", [failed, failed, failed, failed]);
    const outage = scripted("projection:outage", [failed, failed, { outcome: "advanced" }]);
    const healthy = scripted("projection:healthy", [{ outcome: "advanced" }]);
    const { clock, dispatcher } = await setUp([poisoned, healthy, outage]);
    await dispatcher.processOnce();
    expect((await failingOf(dispatcher, "projection:poisoned"))?.retryAt).toBe(
      new Date(clock.now().getTime() + 1_000).toISOString(),
    );
    await dispatcher.processOnce();
    await dispatcher.processOnce();
    expect(await failingOf(dispatcher, "projection:outage")).toBeUndefined();
    expect((await failingOf(dispatcher, "projection:poisoned"))?.retryAt).toBe(
      clock.now().toISOString(),
    );
    await dispatcher.catchUp("projection");
    expect(poisoned.deliveries).toBe(4);
  });

  it("waits out the backoff of the others when a failing subscriber only turns idle", async () => {
    const poisoned = scripted("projection:poisoned", [failed, failed]);
    const settled = scripted("projection:settled", [failed, { outcome: "idle" }]);
    const { clock, dispatcher } = await setUp([poisoned, settled]);
    await dispatcher.processOnce();
    await dispatcher.processOnce();
    expect(await failingOf(dispatcher, "projection:settled")).toBeUndefined();
    expect((await failingOf(dispatcher, "projection:poisoned"))?.retryAt).toBe(
      new Date(clock.now().getTime() + 2_000).toISOString(),
    );
  });

  it("backs off for a second, then up to thirty, unless told otherwise", async () => {
    const poisoned = scripted(
      "projection:poisoned",
      Array.from({ length: 7 }, () => failed),
    );
    const { eventStore, checkpointStore } = await memory().createStorage({ logger: silentLogger });
    const clock = createFixedClock();
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [poisoned],
      batchSize: 10,
      pollIntervalMs: 100,
      logger: silentLogger,
    });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await dispatcher.processOnce();
      const retryAt = (await failingOf(dispatcher, "projection:poisoned"))?.retryAt ?? "";
      delays.push(new Date(retryAt).getTime() - clock.now().getTime());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it("makes catchUp wait for the backoff while processUntilIdle tries regardless", async () => {
    const poisoned = scripted("projection:poisoned", [failed, failed, failed]);
    const { clock, dispatcher } = await setUp([poisoned]);
    await dispatcher.catchUp("projection");
    await dispatcher.catchUp("projection");
    expect(poisoned.deliveries).toBe(1);
    await dispatcher.processUntilIdle();
    expect(poisoned.deliveries).toBe(2);
    clock.advance(1_999);
    await dispatcher.catchUp("projection");
    expect(poisoned.deliveries).toBe(2);
    clock.advance(1);
    await dispatcher.catchUp("projection");
    expect(poisoned.deliveries).toBe(3);
  });

  it("arms the next pass for the retry when that comes before the idle wait", async () => {
    const adapter = memory();
    const { eventStore, checkpointStore, notifier } = await adapter.createStorage({
      logger: silentLogger,
    });
    const clock = createFixedClock();
    let broken = true;
    let attempts = 0;
    const flaky: Subscriber = {
      name: "flaky",
      kind: "projection",
      process: async () => {
        attempts += 1;
        if (broken) throw new Error("boom");
        return true;
      },
    };
    const dispatcher = createDispatcher({
      clock,
      eventStore,
      checkpointStore,
      subscribers: [flaky],
      batchSize: 10,
      pollIntervalMs: 100,
      idleIntervalMs: 60_000,
      backoff: { baseDelayMs: 1_000, maxDelayMs: 4_000 },
      ...(notifier === undefined ? {} : { notifier }),
      logger: silentLogger,
    });
    dispatcher.start();
    await advanceUntilWaiting(clock, 100);
    await eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    await eventually(async () => {
      expect(await failingOf(dispatcher, "flaky")).toBeDefined();
      expect(clock.pending()).toBe(1);
    });
    broken = false;
    const pending = clock.pending();
    clock.advance(999);
    expect(clock.pending()).toBe(pending);
    expect(attempts).toBe(1);
    clock.advance(1);
    await eventually(() => expect(attempts).toBe(2));
    await dispatcher.stop();
    expect(await checkpointStore.get("flaky")).toBe(1);
  });
});
