import { describe, expect, it } from "vitest";
import { createReactionCommandIds } from "../shared/idempotency-key.ts";
import { createKernelHarness } from "../test-support.ts";
import { createUnitOfWork } from "../unit-of-work/unit-of-work.ts";
import { scheduledCommandKey } from "./pipeline.ts";
import { createReactionCommands, ReactionAbandonedError } from "./reaction-commands.ts";

const context = { correlationId: "req-1", causationId: "evt-1", depth: 4 };

const setUp = async () => {
  const harness = await createKernelHarness();
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
});
