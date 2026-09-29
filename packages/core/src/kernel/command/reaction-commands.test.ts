import { describe, expect, it } from "vitest";
import { createReactionCommandIds } from "../shared/idempotency-key.ts";
import { createKernelHarness } from "../test-support.ts";
import { scheduledCommandKey } from "./pipeline.ts";
import { createReactionCommands } from "./reaction-commands.ts";

const context = { correlationId: "req-1", causationId: "evt-1", depth: 4 };

const setUp = async () => {
  const harness = await createKernelHarness();
  const reaction = createReactionCommands({
    aggregates: harness.aggregates,
    pipeline: harness.pipeline,
    scheduler: harness.storage.scheduler,
    context,
    idempotencyKey: "key-1",
  });
  return { ...harness, reaction };
};

describe("createReactionCommands", () => {
  it("dispatches one causal hop deeper, with ids derived from the idempotency key", async () => {
    const { reaction, storage } = await setUp();
    await reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });
    await reaction.commands.payOrder?.({ orderId: "o-1", method: "card" }, { delay: "1h" });

    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events[0]?.metadata).toMatchObject({ correlationId: "req-1", depth: 5 });
    const ids = createReactionCommandIds("key-1");
    expect(await storage.scheduler.list()).toMatchObject([
      { dedupeKey: scheduledCommandKey(ids("PayOrder")) },
    ]);
    expect(reaction.signal.aborted).toBe(false);
  });

  it("cancels the delayed commands of an abandoned run and keeps what already happened", async () => {
    const { reaction, storage } = await setUp();
    await reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });
    await reaction.commands.payOrder?.({ orderId: "o-1", method: "card" }, { delay: "1h" });
    await reaction.commands.archiveOrder?.({ orderId: "o-1" }, { delay: "2h" });
    expect(await storage.scheduler.list()).toHaveLength(2);

    await reaction.abandon(new Error("down"));

    expect(await storage.scheduler.list()).toEqual([]);
    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events.map((event) => event.type)).toEqual(["OrderPlaced"]);
  });

  it("waits for a delayed command still being scheduled before cancelling it", async () => {
    const { reaction, storage } = await setUp();
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const schedule = storage.scheduler.schedule.bind(storage.scheduler);
    storage.scheduler.schedule = async (args) => {
      reached.resolve();
      await gate.promise;
      return schedule(args);
    };
    const scheduling = reaction.commands.placeOrder?.(
      { orderId: "o-1", total: 3 },
      { delay: "1h" },
    );
    await reached.promise;

    const abandoning = reaction.abandon(new Error("down"));
    gate.resolve();
    await abandoning;

    await expect(scheduling).resolves.toMatchObject({ scheduled: true });
    expect(await storage.scheduler.list()).toEqual([]);
  });

  it("refuses commands after the run is abandoned, and aborts its signal with the reason", async () => {
    const { reaction, storage } = await setUp();
    const reason = new Error("timed out");

    await reaction.abandon(reason);

    expect(reaction.signal.aborted).toBe(true);
    expect(reaction.signal.reason).toBe(reason);
    await expect(reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 })).rejects.toBe(reason);
    expect(
      await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" }),
    ).toMatchObject({ events: [] });
  });
});
