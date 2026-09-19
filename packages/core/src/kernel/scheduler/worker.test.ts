import { describe, expect, it } from "vitest";
import { ConcurrencyError, DomainError } from "../../contracts/errors.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { COMMAND_FAILED_EVENT } from "../system-events.ts";
import { orderRegistry, sentMessages } from "../test-support.ts";

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
      },
    ]);
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
    await new Promise((resolve) => setTimeout(resolve, 250));
    await harness.worker.stop();
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.storage.deadLetterStore.count()).toBe(1);
    expect(await harness.storage.eventStore.lastPosition()).toBe(0);
  });
});
