import { describe, expect, it } from "vitest";
import { createReactionCommandIds } from "../shared/idempotency-key.ts";
import { createKernelHarness, createRecordingLogger } from "../test-support.ts";
import { createUnitOfWork, type UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import { scheduledCommandKey } from "./pipeline.ts";
import { createReactionCommands, ReactionAbandonedError } from "./reaction-commands.ts";

const context = { correlationId: "req-1", causationId: "evt-1", depth: 4 };

const setUp = async (withUnit = false) => {
  const harness = await createKernelHarness();
  const { logger, entries } = createRecordingLogger();
  const unit: UnitOfWork | undefined = withUnit
    ? createUnitOfWork({ storage: harness.storage })
    : undefined;
  const reaction = createReactionCommands({
    aggregates: harness.aggregates,
    pipeline: harness.pipeline,
    scheduler: harness.storage.scheduler,
    logger,
    context,
    idempotencyKey: "key-1",
    within: unit,
  });
  return { ...harness, reaction, entries, unit };
};

const holdScheduling = (scheduler: Awaited<ReturnType<typeof setUp>>["storage"]["scheduler"]) => {
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const schedule = scheduler.schedule.bind(scheduler);
  scheduler.schedule = async (args) => {
    reached.resolve();
    await gate.promise;
    return schedule(args);
  };
  return { reached: reached.promise, release: () => gate.resolve() };
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

  it("keeps a run's commands, immediate and delayed, in its unit until it commits, as decisions without a position", async () => {
    const { reaction, storage, unit } = await setUp(true);
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

  it("leaves a retry's delayed command alone when the abandoned run's scheduling lands late", async () => {
    const { reaction, storage, aggregates, pipeline } = await setUp();
    const held = holdScheduling(storage.scheduler);
    const late = reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 }, { delay: "1h" });
    await held.reached;
    await reaction.abandon(new Error("timed out"));
    const retry = createReactionCommands({
      aggregates,
      pipeline,
      scheduler: storage.scheduler,
      logger: createRecordingLogger().logger,
      context,
      idempotencyKey: "key-1",
    });

    held.release();
    await retry.commands.placeOrder?.({ orderId: "o-1", total: 3 }, { delay: "1h" });
    await late;

    expect(await storage.scheduler.list()).toHaveLength(1);
  });

  it("does not wait on a delayed command whose scheduling never ends", async () => {
    const { reaction, storage } = await setUp();
    const held = holdScheduling(storage.scheduler);
    void reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 }, { delay: "1h" });
    await held.reached;

    await expect(reaction.abandon(new Error("timed out"))).resolves.toBeUndefined();
  });

  it("warns when a delayed command cannot be cancelled, and still resolves", async () => {
    const { reaction, storage, entries } = await setUp();
    await reaction.commands.payOrder?.({ orderId: "o-1", method: "card" }, { delay: "1h" });
    storage.scheduler.cancel = async () => {
      throw new Error("store down");
    };

    await expect(reaction.abandon(new Error("refused"))).resolves.toBeUndefined();

    expect(entries).toContainEqual({
      level: "warn",
      message: "delayed command of an abandoned run not cancelled",
      fields: { dedupeKey: expect.any(String), error: "store down" },
    });
  });

  it("refuses commands after the run is abandoned, saying why, and aborts its signal", async () => {
    const { reaction, storage } = await setUp();
    const reason = new Error("timed out");

    await reaction.abandon(reason);

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
