import { describe, expect, it } from "vitest";
import type { Registry } from "../../modules/registry.ts";
import { createReactionCommandIds } from "../shared/idempotency-key.ts";
import { createKernelHarness, drained, orderRegistry, slowJob } from "../test-support.ts";
import { createUnitOfWork } from "../unit-of-work/unit-of-work.ts";
import { scheduledCommandKey } from "./pipeline.ts";
import { createReactionCommands, ReactionAbandonedError } from "./reaction-commands.ts";

const context = { correlationId: "req-1", causationId: "evt-1", depth: 4 };

const setUp = async (registry: Registry = orderRegistry) => {
  const harness = await createKernelHarness({ registry });
  const unit = createUnitOfWork({ storage: harness.storage });
  const reaction = createReactionCommands({
    aggregates: harness.aggregates,
    pipeline: harness.pipeline,
    context,
    idempotencyKey: "key-1",
    within: unit,
  });
  return { ...harness, reaction, unit };
};

describe("createReactionCommands", () => {
  it("dispatches one causal hop deeper, with ids derived from the idempotency key", async () => {
    const { reaction, storage, unit } = await setUp();
    await reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });
    await reaction.commands.payOrder?.({ orderId: "o-1", method: "card" }, { delay: "1h" });
    await unit.commit();

    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events[0]?.metadata).toMatchObject({ correlationId: "req-1", depth: 5 });
    const ids = createReactionCommandIds("key-1");
    expect(await storage.scheduler.list()).toMatchObject([
      { dedupeKey: scheduledCommandKey(ids("PayOrder")) },
    ]);
    expect(reaction.signal.aborted).toBe(false);
  });

  it("keeps a run's commands, immediate and delayed, in its unit until it commits, as decisions without a position", async () => {
    const { reaction, storage, unit } = await setUp();
    const placed = await reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });
    const paid = await reaction.commands.payOrder?.({ orderId: "o-1", method: "card" });
    await reaction.commands.archiveOrder?.({ orderId: "o-1" }, { delay: "1h" });

    expect(placed).toEqual({
      scheduled: false,
      aggregateType: "order",
      aggregateId: "o-1",
      version: 1,
      eventIds: ["id-1"],
      eventTypes: ["OrderPlaced"],
    });
    expect(paid).toMatchObject({ scheduled: false, version: 2, eventTypes: ["OrderPaid"] });
    expect(await storage.eventStore.lastPosition()).toBe(0);
    expect(await storage.scheduler.list()).toEqual([]);

    const cancelled: string[] = [];
    storage.scheduler.cancel = async (dedupeKey) => {
      cancelled.push(dedupeKey);
    };
    await reaction.abandon(new Error("too late"));
    expect(cancelled).toEqual([]);
    expect(await storage.scheduler.list()).toEqual([]);
    await unit?.commit();
    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events.map((event) => [event.type, event.position])).toEqual([
      ["OrderPlaced", 1],
      ["OrderPaid", 2],
    ]);
    expect(await storage.scheduler.list()).toHaveLength(1);
  });

  it("refuses commands after the run is abandoned, saying why, and aborts its signal", async () => {
    const { reaction, storage } = await setUp();
    const reason = new Error("timed out");

    reaction.abandon(reason);

    expect(reaction.signal.aborted).toBe(true);
    expect(reaction.signal.reason).toBe(reason);
    const refused = reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });
    await expect(refused).rejects.toBeInstanceOf(ReactionAbandonedError);
    await expect(refused).rejects.toMatchObject({
      code: "REACTION_ABANDONED",
      message: "The run that dispatched this command was abandoned: timed out",
      cause: reason,
    });
    expect(
      await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" }),
    ).toMatchObject({ events: [] });
  });

  it("stops a command still running when the run is abandoned", async () => {
    const { registry, started } = slowJob();
    const { reaction } = await setUp(registry);
    const reason = new Error("timed out");
    const outcome = reaction.commands.runJob?.({ jobId: "j-1" });
    const signal = await started;
    reaction.abandon(reason);

    await expect(outcome).rejects.toMatchObject({ code: "REACTION_ABANDONED", cause: reason });
    expect(signal.reason).toMatchObject({ code: "REACTION_ABANDONED", cause: reason });
    expect(reaction.signal.reason).toBe(reason);
  });

  it("leaves no dispatch the handler did not await unhandled when the run is abandoned", async () => {
    const { registry, started } = slowJob();
    const { reaction } = await setUp(registry);
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      void reaction.commands.runJob?.({ jobId: "j-1" });
      await started;
      reaction.abandon(new Error("timed out"));
      void reaction.commands.runJob?.({ jobId: "j-2" });
      await drained();
      await drained();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("keeps the error of a command that failed on its own when the run is then abandoned", async () => {
    const { reaction } = await setUp();
    const refused = reaction.commands.payOrder?.({ orderId: "o-1", method: "card" });
    await expect(refused).rejects.toThrow("Only placed orders can be paid");
    reaction.abandon(new Error("timed out"));
    await expect(refused).rejects.toThrow("Only placed orders can be paid");
  });

  it("lets a handler withdraw a command it dispatched without abandoning its run", async () => {
    const { registry, started } = slowJob();
    const { reaction } = await setUp(registry);
    const controller = new AbortController();
    const reason = new Error("no longer needed");
    const outcome = reaction.commands.runJob?.({ jobId: "j-1" }, { signal: controller.signal });
    await started;
    controller.abort(reason);

    await expect(outcome).rejects.toBe(reason);
    expect(reaction.signal.aborted).toBe(false);
  });
});
