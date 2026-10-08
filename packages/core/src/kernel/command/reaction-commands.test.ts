import { describe, expect, it } from "vitest";
import { ValidationError } from "../../contracts/errors.ts";
import type { Registry } from "../../modules/registry.ts";
import { createReactionCommandIds } from "../shared/idempotency-key.ts";
import {
  createKernelHarness,
  createRecordingLogger,
  drained,
  orderRegistry,
  slowJob,
} from "../test-support.ts";
import { createUnitOfWork } from "../unit-of-work/unit-of-work.ts";
import { scheduledCommandKey } from "./pipeline.ts";
import {
  createReactionCommands,
  ReactionAbandonedError,
  ReactionFinishedError,
} from "./reaction-commands.ts";

const context = { correlationId: "req-1", causationId: "evt-1", depth: 4 };

const setUp = async (registry: Registry = orderRegistry) => {
  const harness = await createKernelHarness({ registry });
  const unit = createUnitOfWork({ storage: harness.storage });
  const { logger, entries } = createRecordingLogger();
  const reaction = createReactionCommands({
    aggregates: harness.aggregates,
    pipeline: harness.pipeline,
    context,
    idempotencyKey: "key-1",
    within: unit,
    logger,
  });
  return { ...harness, reaction, unit, entries };
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

  it("keeps a run's commands, immediate and scheduled, in its unit until it commits, as decisions without a position", async () => {
    const { reaction, storage, unit } = await setUp();
    const placed = await reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });
    const paid = await reaction.commands.payOrder?.({ orderId: "o-1", method: "card" });
    await reaction.commands.archiveOrder?.({ orderId: "o-1" }, { delay: "1h" });

    expect(placed).toEqual({
      rejected: false,
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

  it("refuses a command dispatched once decided has resolved, naming it, and logs the refusal", async () => {
    const { reaction, unit, entries } = await setUp();
    await reaction.decided();
    const late = reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });

    await expect(late).rejects.toBeInstanceOf(ReactionFinishedError);
    await expect(late).rejects.toMatchObject({
      code: "REACTION_FINISHED",
      command: "PlaceOrder",
      message:
        "Command PlaceOrder was dispatched after its run had finished: dispatch commands while the handler runs",
    });
    expect(
      await unit.eventStore.load({ aggregateType: "order", aggregateId: "o-1" }),
    ).toMatchObject({ events: [] });
    expect(entries).toEqual([
      {
        level: "error",
        message: "command dispatched after its run had finished; refused",
        fields: { command: "PlaceOrder", correlationId: "req-1", causationId: "evt-1" },
      },
    ]);
    expect(reaction.signal.aborted).toBe(false);
  });

  it("leaves no command refused once the run has finished unhandled", async () => {
    const { reaction } = await setUp();
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      await reaction.decided();
      void reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });
      await drained();
      await drained();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("refuses commands dispatched once decided has rejected", async () => {
    const { reaction } = await setUp();
    void reaction.commands.payOrder?.({ orderId: "o-1", method: "cash" });
    await expect(reaction.decided()).rejects.toThrow(ValidationError);

    await expect(
      reaction.commands.placeOrder?.({ orderId: "o-2", total: 3 }),
    ).rejects.toBeInstanceOf(ReactionFinishedError);
  });

  it("refuses commands with the abandonment when the run was abandoned after decided settled", async () => {
    const { reaction } = await setUp();
    await reaction.decided();
    reaction.abandon(new Error("timed out"));

    await expect(
      reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 }),
    ).rejects.toBeInstanceOf(ReactionAbandonedError);
  });

  it("refuses commands after the run is abandoned, saying why, logs the refusal and aborts its signal", async () => {
    const { reaction, unit, entries } = await setUp();
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
      await unit.eventStore.load({ aggregateType: "order", aggregateId: "o-1" }),
    ).toMatchObject({ events: [] });
    expect(entries).toEqual([
      {
        level: "warn",
        message: "command dispatched after its run was abandoned; refused",
        fields: { command: "PlaceOrder", correlationId: "req-1", causationId: "evt-1" },
      },
    ]);
  });

  it("refuses a command after the run is abandoned before validating its payload", async () => {
    const { reaction } = await setUp();
    reaction.abandon(new Error("timed out"));

    await expect(
      reaction.commands.payOrder?.({ orderId: "o-1", method: "cash" }),
    ).rejects.toBeInstanceOf(ReactionAbandonedError);
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
    const failed = reaction.commands.payOrder?.({ orderId: "o-1", method: "cash" });
    await expect(failed).rejects.toThrow(ValidationError);
    reaction.abandon(new Error("timed out"));
    await expect(failed).rejects.toThrow(ValidationError);
  });

  it("resolves a rejected command with its code and message, deciding nothing", async () => {
    const { reaction, storage, unit } = await setUp();
    const paid = await reaction.commands.payOrder?.({ orderId: "o-1", method: "card" });
    await unit.commit();

    expect(paid).toEqual({
      rejected: "NotPlaced",
      message: "Only placed orders can be paid; this one is new",
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(await reaction.decided()).toEqual([paid]);
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("waits for the commands the handler did not await, and rejects with the first that failed", async () => {
    const { reaction } = await setUp();
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      void reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });
      void reaction.commands.payOrder?.({ orderId: "o-2", method: "cash" });
      void reaction.commands.archiveOrder?.({});
      await expect(reaction.decided()).rejects.toThrow("Invalid payload for command PayOrder");
      await drained();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("resolves decided with every decision, those the handler did not await included", async () => {
    const { reaction } = await setUp();
    void reaction.commands.placeOrder?.({ orderId: "o-1", total: 3 });
    void reaction.commands.payOrder?.({ orderId: "o-2", method: "card" });

    const decided = await reaction.decided();
    expect(decided).toHaveLength(2);
    expect(decided).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rejected: false, eventTypes: ["OrderPlaced"] }),
        expect.objectContaining({ rejected: "NotPlaced" }),
      ]),
    );
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
    expect(await reaction.decided()).toEqual([]);
  });

  it("still fails the run for a command that failed before the handler withdrew it", async () => {
    const { reaction } = await setUp();
    const controller = new AbortController();
    const failed = reaction.commands.payOrder?.(
      { orderId: "o-1", method: "cash" },
      { signal: controller.signal },
    );
    await expect(failed).rejects.toThrow(ValidationError);
    controller.abort(new Error("no longer needed"));

    await expect(reaction.decided()).rejects.toThrow(ValidationError);
  });

  it("resolves a command dispatched with a delay as not rejected and scheduled", async () => {
    const { reaction } = await setUp();
    expect(await reaction.commands.archiveOrder?.({ orderId: "o-1" }, { delay: "1h" })).toEqual({
      rejected: false,
      scheduled: true,
      aggregateType: "order",
      aggregateId: "o-1",
      executeAt: expect.any(String),
    });
  });
});
