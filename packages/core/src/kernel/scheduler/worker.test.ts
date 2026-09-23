import { describe, expect, it } from "vitest";
import { ConcurrencyError, DomainError } from "../../contracts/errors.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { COMMAND_FAILED_EVENT } from "../system-events.ts";
import {
  advanceUntilWaiting,
  createRecordingLogger,
  eventually,
  orderRegistry,
  sentMessages,
} from "../test-support.ts";

describe("scheduled command worker", () => {
  it("runs due commands with their stored context and completes them", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    sentMessages.length = 0;
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: "10m", correlationId: "req-7" },
    });
    expect(await harness.worker.runOnce()).toBe(0);
    expect(sentMessages).toEqual([]);

    harness.clock.advance(600_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(sentMessages).toEqual(["placed o-1 v0"]);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(order.events[0]?.metadata).toMatchObject({ correlationId: "req-7", depth: 0 });
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.worker.runOnce()).toBe(0);
  });

  it("drops a command that fails for good, records CommandFailed and dead-letters it", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 99 },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    expect(await harness.worker.runOnce()).toBe(1);

    expect(await harness.storage.scheduler.list()).toEqual([]);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(order.events.map((event) => event.type)).toEqual(["OrderPlaced", COMMAND_FAILED_EVENT]);
    expect(order.events[1]).toMatchObject({
      payload: { commandType: "PlaceOrder", error: "Order already placed", attempts: 1 },
      metadata: { system: true },
    });
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        kind: "command",
        eventType: "PlaceOrder",
        aggregateType: "order",
        aggregateId: "o-1",
        errorType: "terminal",
        payload: { orderId: "o-1", total: 99 },
      },
    ]);
    await expect(
      harness.pipeline.dispatch({ type: "PayOrder", payload: { orderId: "o-1", method: "card" } }),
    ).resolves.toMatchObject({ version: 3 });
  });

  it("reschedules transient failures with back-off and gives up after the configured attempts", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 2, baseDelay: "30s" } } },
      },
    });
    const original = harness.pipeline.dispatch.bind(harness.pipeline);
    let failures = 5;
    harness.pipeline.dispatch = async (args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("db unavailable");
      }
      return original(args);
    };
    await original({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: 0 },
    });

    expect(await harness.worker.runOnce()).toBe(1);
    const [rescheduled] = await harness.storage.scheduler.list();
    expect(rescheduled).toMatchObject({ attempts: 1, executeAt: "2026-01-01T00:00:30.000Z" });

    harness.clock.advance(29_000);
    expect(await harness.worker.runOnce()).toBe(0);
    harness.clock.advance(1_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        kind: "command",
        errorType: "retriable_exhausted",
        attempts: 2,
        errorMessage: "db unavailable",
        errorStack: expect.stringContaining("db unavailable"),
      },
    ]);
  });

  it("drops a retriable failure at once when retries are off", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    const original = harness.pipeline.dispatch.bind(harness.pipeline);
    harness.pipeline.dispatch = async () => {
      const bare = new Error("db unavailable");
      Reflect.deleteProperty(bare, "stack");
      throw bare;
    };
    await original({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: 0 },
    });
    expect(await harness.worker.runOnce()).toBe(1);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const [letter] = await harness.storage.deadLetterStore.list();
    expect(letter).toMatchObject({
      errorType: "retriable_exhausted",
      attempts: 1,
      errorMessage: "db unavailable",
    });
    expect(letter).not.toHaveProperty("errorStack");
  });

  it("claims due commands with a lease of twice the handler timeout", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: { runtime: { policies: { timeout: "10s" } } },
    });
    const leases: number[] = [];
    const original = harness.storage.scheduler.claimDue.bind(harness.storage.scheduler);
    harness.storage.scheduler.claimDue = async (args) => {
      leases.push(args.leaseMs);
      return original(args);
    };
    await harness.worker.runOnce();
    expect(leases).toEqual([20_000]);
  });

  it("arms one timer per interval, re-arms after each run and leaves nothing behind on stop", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    const scheduler = harness.storage.scheduler;
    const original = scheduler.claimDue.bind(scheduler);
    let release: () => void = () => undefined;
    let claims = 0;
    scheduler.claimDue = async (args) => {
      claims += 1;
      if (claims === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(args);
    };
    const interval = harness.config.runtime.dispatcher.pollIntervalMs;
    harness.worker.start();
    harness.worker.start();
    expect(harness.clock.pending()).toBe(1);

    await advanceUntilWaiting(harness.clock, interval);
    expect(claims).toBe(1);

    harness.clock.advance(interval);
    await eventually(() => expect(claims).toBe(2));
    expect(harness.clock.pending()).toBe(0);

    const stopping = harness.worker.stop();
    release();
    await stopping;
    expect(harness.clock.pending()).toBe(0);
    harness.clock.advance(interval * 5);
    expect(claims).toBe(2);
  });

  it("reports a failing run and keeps polling", async () => {
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({ registry: orderRegistry, logger });
    sentMessages.length = 0;
    const scheduler = harness.storage.scheduler;
    const original = scheduler.claimDue.bind(scheduler);
    let failures = 1;
    scheduler.claimDue = async (args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("scheduler unavailable");
      }
      return original(args);
    };
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: 0 },
    });
    const interval = harness.config.runtime.dispatcher.pollIntervalMs;
    harness.worker.start();
    await advanceUntilWaiting(harness.clock, interval);
    expect(entries).toEqual([
      {
        level: "error",
        message: "scheduled command worker failed",
        fields: { message: "scheduler unavailable", stack: expect.any(String) },
      },
    ]);
    await advanceUntilWaiting(harness.clock, interval);
    expect(sentMessages).toEqual(["placed o-1 v0"]);
    await harness.worker.stop();
  });

  it("treats a concurrency conflict from the pipeline as transient", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    harness.pipeline.dispatch = async () => {
      throw new ConcurrencyError({ streamId: "order:o-1", expectedVersion: 0, actualVersion: 1 });
    };
    await harness.storage.scheduler.schedule({
      dedupeKey: "command:x",
      command: { type: "TouchOrder", aggregateId: "o-1", payload: { orderId: "o-1" } },
      executeAt: harness.clock.now(),
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });
    await harness.worker.runOnce();
    expect((await harness.storage.scheduler.list())[0]?.attempts).toBe(1);
  });

  it("does not record CommandFailed for domain errors on unknown aggregates and polls in the background", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    harness.pipeline.dispatch = async () => {
      throw new DomainError("nope");
    };
    await harness.storage.scheduler.schedule({
      dedupeKey: "command:y",
      command: { type: "Unknown", aggregateId: "z", payload: {} },
      executeAt: harness.clock.now(),
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });
    harness.worker.start();
    harness.worker.start();
    expect(harness.clock.pending()).toBe(1);
    await advanceUntilWaiting(harness.clock, harness.config.runtime.dispatcher.pollIntervalMs);
    await harness.worker.stop();
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.storage.deadLetterStore.count()).toBe(1);
    expect(await harness.storage.eventStore.lastPosition()).toBe(0);
  });
});
