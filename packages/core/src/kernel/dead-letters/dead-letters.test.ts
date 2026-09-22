import { describe, expect, it } from "vitest";
import { ConfigurationError, DomainError, NotFoundError } from "../../contracts/errors.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { ProcessConfigArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { PROCESS_EVENTS } from "../process/lifecycle.ts";
import { PROCESS_TIMEOUT_COMMAND } from "../process/runner.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { createRecordingLogger, orderAggregateEntry } from "../test-support.ts";
import { createDeadLetters, type DeadLetters } from "./dead-letters.ts";

const calls: string[] = [];
let policyMode: "ok" | "domain" | "slow" = "domain";
let processMode: "ok" | "domain" = "domain";

const registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      policies: {
        notifyOnOrderPlaced: {
          handler: async ({
            event,
            commands,
          }: {
            event: { aggregateId: string };
            commands: { archiveOrder: (payload: { orderId: string }) => Promise<unknown> };
          }) => {
            calls.push(`notify:${event.aggregateId}`);
            if (policyMode === "domain") throw new DomainError("mail server rejects it");
            if (policyMode === "slow") await new Promise((resolve) => setTimeout(resolve, 60));
            await commands.archiveOrder({ orderId: event.aggregateId });
          },
        },
      },
      processes: {
        orderPayment: {
          module: {
            config: ({ events }: ProcessConfigArgs<"OrderPlaced" | "OrderPaid">) => ({
              startedBy: [events.OrderPlaced],
              completedBy: [events.OrderPaid],
              timeout: "48h",
            }),
            state: ({ z }: PayloadArgs) =>
              z.object({ method: z.string().nullable().default(null) }),
          },
          handlers: {
            orderPaid: {
              handler: ({ event }: { event: { payload: { method: string } } }) => {
                calls.push(`paid:${event.payload.method}`);
                if (processMode === "domain") throw new DomainError("payment provider says no");
                return { method: event.payload.method };
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
} satisfies Registry;

const setUp = async () => {
  calls.length = 0;
  const { logger, entries } = createRecordingLogger();
  const harness = await createReactiveHarness({
    registry,
    logger,
    config: { runtime: { policies: { retry: { strategy: "none" } } } },
  });
  const deadLetters: DeadLetters = createDeadLetters({
    storage: harness.storage,
    aggregates: harness.aggregates,
    pipeline: harness.pipeline,
    policies: harness.policies,
    processes: harness.processes,
    config: harness.config,
    ids: harness.ids,
    clock: harness.clock,
    logger,
  });
  return { harness, deadLetters, entries };
};

describe("deadLetters", () => {
  it("replays a policy for its stored event and marks the letter replayed", async () => {
    policyMode = "domain";
    const { harness, deadLetters, entries } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({ kind: "policy", subscriber: "order.notifyOnOrderPlaced" });
    expect(await deadLetters.count({ status: "failed" })).toBe(1);
    expect(calls).toEqual(["notify:o-1"]);

    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow("mail server rejects it");
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");

    policyMode = "ok";
    expect(await deadLetters.replay(letter?.id ?? "")).toMatchObject({
      id: letter?.id,
      status: "replayed",
    });
    expect(calls).toEqual(["notify:o-1", "notify:o-1", "notify:o-1"]);
    expect(await deadLetters.list({ status: "replayed" })).toHaveLength(1);
    expect(entries).toContainEqual({
      level: "info",
      message: "dead letter replayed",
      fields: {
        id: letter?.id,
        kind: "policy",
        subscriber: "order.notifyOnOrderPlaced",
        at: harness.clock.now().toISOString(),
      },
    });
    await harness.dispatcher.processUntilIdle();
    expect(calls).toHaveLength(3);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const [placed, ...archived] = events;
    expect(archived.map((event) => event.type)).toEqual(["OrderArchived"]);
    expect(archived.at(-1)?.metadata).toMatchObject({
      correlationId: placed?.metadata.correlationId,
      depth: 1,
    });
  });

  it("gives a replayed policy the same time budget as a live one, naming it", async () => {
    policyMode = "domain";
    const { logger } = createRecordingLogger();
    const harness = await createReactiveHarness({
      registry,
      logger,
      config: { runtime: { policies: { retry: { strategy: "none" }, timeout: "20ms" } } },
    });
    const deadLetters = createDeadLetters({
      storage: harness.storage,
      aggregates: harness.aggregates,
      pipeline: harness.pipeline,
      policies: harness.policies,
      processes: harness.processes,
      config: harness.config,
      ids: harness.ids,
      clock: harness.clock,
      logger,
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    const [letter] = await deadLetters.list();
    policyMode = "slow";
    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow(
      "policy order.notifyOnOrderPlaced did not finish within 20ms",
    );
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");
  });

  it("refuses to touch a letter twice, or one that is not there", async () => {
    policyMode = "domain";
    const { harness, deadLetters, entries } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    const [letter] = await deadLetters.list();
    const id = letter?.id ?? "";

    expect(await deadLetters.discard(id)).toMatchObject({ id, status: "discarded" });
    expect(entries).toContainEqual({
      level: "info",
      message: "dead letter discarded",
      fields: { id, kind: "policy", subscriber: "order.notifyOnOrderPlaced" },
    });
    await expect(deadLetters.replay(id)).rejects.toThrow(
      new ConfigurationError(`Dead letter "${id}" was already discarded`),
    );
    await expect(deadLetters.discard(id)).rejects.toThrow(/already discarded/);
    await expect(deadLetters.replay("nope")).rejects.toThrow(
      new NotFoundError('Dead letter "nope" not found'),
    );
    await expect(deadLetters.discard("nope")).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toEqual(["notify:o-1"]);
  });

  it("replays a process handler, reopens the failed process and re-arms its timeout", async () => {
    policyMode = "ok";
    processMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(3_600_000);
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    const [letter] = await deadLetters.list({ kind: "process" });
    expect(letter).toMatchObject({ subscriber: "order.orderPayment", eventType: "OrderPaid" });
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const stream = { aggregateType: "process:OrderPayment", aggregateId: "o-1" };
    expect(
      (await harness.storage.eventStore.load(stream)).events.map((event) => event.type),
    ).toEqual([PROCESS_EVENTS.started, PROCESS_EVENTS.failed]);

    processMode = "ok";
    expect((await deadLetters.replay(letter?.id ?? "")).status).toBe("replayed");
    expect(calls.filter((call) => call.startsWith("paid:"))).toEqual(["paid:card", "paid:card"]);
    expect(
      (await harness.storage.eventStore.load(stream)).events.map((event) => event.type),
    ).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });

  it("re-arms the timeout at the original deadline when the process stays open", async () => {
    policyMode = "domain";
    processMode = "domain";
    const open = {
      ...registry,
      aggregates: {
        order: {
          ...registry.aggregates.order,
          processes: {
            orderPayment: {
              ...registry.aggregates.order.processes.orderPayment,
              module: {
                ...registry.aggregates.order.processes.orderPayment.module,
                config: ({ events }: ProcessConfigArgs<"OrderPlaced" | "OrderArchived">) => ({
                  startedBy: [events.OrderPlaced],
                  completedBy: [events.OrderArchived],
                  timeout: "48h",
                }),
              },
            },
          },
        },
      },
    } satisfies Registry;
    const { logger } = createRecordingLogger();
    const harness = await createReactiveHarness({
      registry: open,
      logger,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    const deadLetters = createDeadLetters({
      storage: harness.storage,
      aggregates: harness.aggregates,
      pipeline: harness.pipeline,
      policies: harness.policies,
      processes: harness.processes,
      config: harness.config,
      ids: harness.ids,
      clock: harness.clock,
      logger,
    });
    const startedAt = harness.clock.now().getTime();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(3_600_000);
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    expect(await harness.storage.scheduler.list()).toEqual([]);

    processMode = "ok";
    const [letter] = await deadLetters.list({ kind: "process" });
    await deadLetters.replay(letter?.id ?? "");
    expect(await harness.storage.scheduler.list()).toMatchObject([
      {
        dedupeKey: "process-timeout:order.orderPayment:o-1",
        executeAt: new Date(startedAt + 48 * 3_600_000).toISOString(),
      },
    ]);

    harness.clock.advance(49 * 3_600_000);
    const late = await deadLetters.list({ kind: "process" });
    expect(late).toHaveLength(1);
  });

  it("re-arms an overdue timeout for now rather than in the past", async () => {
    policyMode = "domain";
    processMode = "domain";
    const open = {
      ...registry,
      aggregates: {
        order: {
          ...registry.aggregates.order,
          processes: {
            orderPayment: {
              ...registry.aggregates.order.processes.orderPayment,
              module: {
                ...registry.aggregates.order.processes.orderPayment.module,
                config: ({ events }: ProcessConfigArgs<"OrderPlaced" | "OrderArchived">) => ({
                  startedBy: [events.OrderPlaced],
                  completedBy: [events.OrderArchived],
                  timeout: "1h",
                }),
              },
            },
          },
        },
      },
    } satisfies Registry;
    const harness = await createReactiveHarness({
      registry: open,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    const deadLetters = createDeadLetters({
      storage: harness.storage,
      aggregates: harness.aggregates,
      pipeline: harness.pipeline,
      policies: harness.policies,
      processes: harness.processes,
      config: harness.config,
      ids: harness.ids,
      clock: harness.clock,
      logger: harness.logger,
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(5 * 3_600_000);
    processMode = "ok";
    const [letter] = await deadLetters.list({ kind: "process" });
    await deadLetters.replay(letter?.id ?? "");
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { executeAt: harness.clock.now().toISOString() },
    ]);
  });

  it("dispatches a dropped command again with its recorded payload", async () => {
    policyMode = "ok";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 99 },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    await harness.worker.runOnce();
    const [letter] = await deadLetters.list({ kind: "command" });
    expect(letter).toMatchObject({
      eventType: "PlaceOrder",
      payload: { orderId: "o-1", total: 99 },
    });

    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow("Order already placed");
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");
  });

  it("dispatches a dropped command that can succeed now", async () => {
    policyMode = "ok";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    await harness.worker.runOnce();
    const [letter] = await deadLetters.list({ kind: "command" });
    expect(letter).toMatchObject({
      eventType: "PayOrder",
      errorMessage: "Only placed orders can be paid",
    });

    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    expect((await deadLetters.replay(letter?.id ?? "")).status).toBe("replayed");
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = events.find((event) => event.type === "OrderPaid");
    expect(paid?.payload).toEqual({ method: "card" });
    expect(paid?.metadata).toMatchObject({ depth: 0 });
    expect(paid?.metadata.correlationId).toEqual(expect.any(String));
  });

  it("explains a command letter without payload and a projection letter", async () => {
    const { harness, deadLetters } = await setUp();
    const base = {
      eventId: "k",
      aggregateType: "order",
      aggregateId: "o-1",
      errorType: "terminal" as const,
      errorMessage: "x",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    };
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "old",
      kind: "command",
      subscriber: "scheduled:PlaceOrder",
      eventType: "PlaceOrder",
    });
    await expect(deadLetters.replay("old")).rejects.toThrow(
      'Dead letter "old" was recorded without the command\'s payload and cannot be replayed',
    );
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "proj",
      kind: "projection",
      subscriber: "projection:orders",
      eventType: "OrderPlaced",
    });
    await expect(deadLetters.replay("proj")).rejects.toThrow(/rebuild the read model instead/);
  });

  it("replays a dropped process timeout through the process runner", async () => {
    policyMode = "ok";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-9", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    await harness.storage.deadLetterStore.add({
      id: "t",
      kind: "command",
      subscriber: `scheduled:${PROCESS_TIMEOUT_COMMAND}`,
      eventId: "process-timeout:order.orderPayment:o-9",
      eventType: PROCESS_TIMEOUT_COMMAND,
      aggregateType: "order.orderPayment",
      aggregateId: "o-9",
      errorType: "terminal",
      errorMessage: "x",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await deadLetters.replay("t")).status).toBe("replayed");
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "process:OrderPayment",
      aggregateId: "o-9",
    });
    expect(events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
    ]);
  });

  it("names a policy or process the registry no longer has, and an event that is gone", async () => {
    const { harness, deadLetters } = await setUp();
    const base = {
      eventId: "missing-event",
      eventType: "OrderPlaced",
      aggregateType: "order",
      aggregateId: "o-1",
      errorType: "terminal" as const,
      errorMessage: "x",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    };
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "p",
      kind: "policy",
      subscriber: "order.gone",
    });
    await expect(deadLetters.replay("p")).rejects.toThrow(
      'Policy "order.gone" is no longer in the registry',
    );
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "e",
      kind: "policy",
      subscriber: "order.notifyOnOrderPlaced",
    });
    await expect(deadLetters.replay("e")).rejects.toThrow(
      new NotFoundError("Event missing-event of order:o-1 not found"),
    );
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    const [placed] = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events;
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "pr",
      kind: "process",
      subscriber: "order.gone",
      eventId: placed?.id ?? "",
    });
    await expect(deadLetters.replay("pr")).rejects.toThrow(
      'Process "order.gone" is no longer in the registry',
    );
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "ph",
      kind: "process",
      subscriber: "order.orderPayment",
      eventId: placed?.id ?? "",
    });
    await expect(deadLetters.replay("ph")).rejects.toThrow(
      'Process "order.orderPayment" no longer handles OrderPlaced',
    );
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "pi",
      kind: "process",
      subscriber: "order.orderPayment",
      eventType: "OrderPaid",
      aggregateId: "o-2",
      eventId: "e-none",
    });
    await expect(deadLetters.replay("pi")).rejects.toBeInstanceOf(NotFoundError);
  });
});
