import { describe, expect, it } from "vitest";
import {
  DeadLetterNotRetriableError,
  DeadLetterSettledError,
  NotFoundError,
  ValidationError,
} from "../../contracts/errors.ts";
import type { RejectFunction } from "../../modules/command.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { PROCESS_DEADLINE_COMMAND } from "../process/deadlines.ts";
import { PROCESS_EVENTS } from "../process/lifecycle.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { SCHEDULED_COMMAND_FAILED_EVENT } from "../system-events.ts";
import { ATTRIBUTES } from "../telemetry.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import {
  breakNextCommit,
  createRecordingLogger,
  type OrderProcessConfigArgs,
  orderAggregateEntry,
} from "../test-support.ts";
import { createDeadLetters, type DeadLetters } from "./dead-letters.ts";

const calls: string[] = [];
const keys: string[] = [];
let policyMode: "ok" | "domain" | "hangs" | "waits" = "domain";
let handlerStarted = Promise.withResolvers<void>();
let gate = Promise.withResolvers<void>();
let processMode: "ok" | "domain" = "domain";
let timeoutMode: "ok" | "domain" = "ok";
let paymentsClosed = false;

const order = orderAggregateEntry();

interface PayOrderArgs {
  readonly command: { readonly payload: { readonly method: string } };
  readonly state: { readonly status: string };
  readonly events: Record<string, (payload?: unknown) => unknown>;
  readonly reject: RejectFunction<"Closed">;
}

// A scheduled command is dropped to a dead letter when it fails, never when it is rejected.
const payOrder = {
  module: {
    payload: order.commands.payOrder.module.payload,
    rejections: () => ({ Closed: "Payments are closed" }),
    handler: ({ command, state, events, reject }: PayOrderArgs) => {
      if (paymentsClosed) return reject("Closed");
      if (state.status !== "placed") {
        throw new ValidationError("Only placed orders can be paid", []);
      }
      return [events.orderPaid?.({ method: command.payload.method })];
    },
  },
};

const registry = {
  aggregates: {
    order: {
      ...order,
      commands: { ...order.commands, payOrder },
      ports: {
        ...order.ports,
        recorder: { memory: { default: { record: (call: string) => calls.push(call) } } },
      },
      policies: {
        notifyOnOrderPlaced: {
          module: {
            handler: async ({
              event,
              commands,
              recorder,
              idempotencyKey,
            }: {
              event: { aggregateId: string };
              commands: { archiveOrder: (payload: { orderId: string }) => Promise<unknown> };
              recorder: { record: (call: string) => void };
              idempotencyKey: string;
            }) => {
              recorder.record(`notify:${event.aggregateId}`);
              keys.push(`policy ${idempotencyKey}`);
              if (policyMode === "domain") throw new ValidationError("mail server rejects it", []);
              if (policyMode === "hangs") {
                handlerStarted.resolve();
                await new Promise<never>(() => undefined);
              }
              if (policyMode === "waits") {
                handlerStarted.resolve();
                await gate.promise;
              }
              await commands.archiveOrder({ orderId: event.aggregateId });
            },
          },
        },
      },
      processes: {
        orderPayment: {
          module: {
            config: ({ events }: OrderProcessConfigArgs<"OrderPlaced" | "OrderPaid">) => ({
              startedBy: [events.order.OrderPlaced],
              completedBy: [events.order.OrderPaid],
              timeout: "48h",
            }),
            state: ({ z }: PayloadArgs) =>
              z.object({ method: z.string().nullable().default(null) }),
          },
          handlers: {
            order: {
              orderPaid: {
                handler: ({
                  event,
                  idempotencyKey,
                }: {
                  event: { payload: { method: string } };
                  idempotencyKey: string;
                }) => {
                  calls.push(`paid:${event.payload.method}`);
                  keys.push(`process ${idempotencyKey}`);
                  if (processMode === "domain")
                    throw new ValidationError("payment provider says no", []);
                  return { method: event.payload.method };
                },
              },
            },
          },
          deadlines: {
            timeout: {
              handler: ({ idempotencyKey }: { idempotencyKey: string }) => {
                keys.push(`timeout ${idempotencyKey}`);
                if (timeoutMode === "domain") throw new ValidationError("courier is closed", []);
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
  paymentsClosed = false;
  calls.length = 0;
  keys.length = 0;
  const { logger, entries } = createRecordingLogger();
  const harness = await createReactiveHarness({
    registry,
    logger,
    config: { runtime: { policies: { retry: { strategy: "none" } } } },
  });
  const deadLetters: DeadLetters = createDeadLetters({
    storage: harness.storage,
    pipeline: harness.pipeline,
    aggregates: harness.aggregates,
    policies: harness.policies,
    policyExecutor: harness.policyExecutor,
    processes: harness.processes,
    config: harness.config,
    ids: harness.ids,
    clock: harness.clock,
    logger,
  });
  return { harness, deadLetters, entries };
};

describe("deadLetters", () => {
  it("retries a policy for its stored event and marks the letter retried", async () => {
    policyMode = "domain";
    const { harness, deadLetters, entries } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({ kind: "policy", handler: "order.notifyOnOrderPlaced" });
    expect(await deadLetters.count({ status: "failed" })).toBe(1);
    expect(calls).toEqual(["notify:o-1"]);

    await expect(deadLetters.retry(letter?.id ?? "")).rejects.toThrow("mail server rejects it");
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");

    policyMode = "ok";
    const telemetry = installFakeTelemetry();
    expect(await deadLetters.retry(letter?.id ?? "")).toMatchObject({
      id: letter?.id,
      status: "retried",
    });
    expect(
      telemetry.spans.find((span) => span.name === "bounda.policy order.notifyOnOrderPlaced"),
    ).toMatchObject({ attributes: { [ATTRIBUTES.attempt]: 2 } });
    telemetry.restore();
    expect(calls).toEqual(["notify:o-1", "notify:o-1", "notify:o-1"]);
    const live = `policy ${deriveIdempotencyKey({ kind: "policy", handler: "order.notifyOnOrderPlaced", subject: letter?.eventId ?? "" })}`;
    expect(keys[0]).toBe(live);
    expect(new Set(keys).size).toBe(3);
    expect(await deadLetters.list({ status: "retried" })).toHaveLength(1);
    expect(entries).toContainEqual({
      level: "info",
      message: "dead letter retried",
      fields: {
        id: letter?.id,
        kind: "policy",
        handler: "order.notifyOnOrderPlaced",
        at: harness.clock.now().toISOString(),
      },
    });
    await harness.dispatcher.runUntilIdle();
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

  it("marks a policy letter retried together with the retry's writes, or neither", async () => {
    policyMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    policyMode = "ok";
    const crash = breakNextCommit(harness.storage);

    await expect(deadLetters.retry(letter?.id ?? "")).rejects.toThrow("connection lost");
    expect(crash.broke()).toBe(true);
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");
    const order = { aggregateType: "order", aggregateId: "o-1" };
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual(["OrderPlaced"]);

    expect((await deadLetters.retry(letter?.id ?? "")).status).toBe("retried");
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual(["OrderPlaced", "OrderArchived"]);
    expect(calls).toEqual(["notify:o-1", "notify:o-1", "notify:o-1"]);
  });

  it("marks a scheduled command letter retried together with the command's events, or neither", async () => {
    policyMode = "ok";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    await harness.worker.runOnce();
    const [letter] = await deadLetters.list({ kind: "scheduled" });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    const crash = breakNextCommit(harness.storage);

    await expect(deadLetters.retry(letter?.id ?? "")).rejects.toThrow("connection lost");
    expect(crash.broke()).toBe(true);
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");
    const order = { aggregateType: "order", aggregateId: "o-1" };
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual([SCHEDULED_COMMAND_FAILED_EVENT, "OrderPlaced"]);

    expect((await deadLetters.retry(letter?.id ?? "")).status).toBe("retried");
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual([SCHEDULED_COMMAND_FAILED_EVENT, "OrderPlaced", "OrderPaid"]);
  });

  it("gives a retried policy the same time budget as a live one, naming it", async () => {
    policyMode = "domain";
    const { logger } = createRecordingLogger();
    const harness = await createReactiveHarness({
      registry,
      logger,
      config: { runtime: { policies: { retry: { strategy: "none" }, timeout: "1h" } } },
    });
    const deadLetters = createDeadLetters({
      storage: harness.storage,
      pipeline: harness.pipeline,
      aggregates: harness.aggregates,
      policies: harness.policies,
      policyExecutor: harness.policyExecutor,
      processes: harness.processes,
      config: harness.config,
      ids: harness.ids,
      clock: harness.clock,
      logger,
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    policyMode = "hangs";
    handlerStarted = Promise.withResolvers<void>();
    const retrying = deadLetters.retry(letter?.id ?? "");
    await handlerStarted.promise;
    harness.clock.advance(3_600_000);
    await expect(retrying).rejects.toThrow(
      "policy order.notifyOnOrderPlaced did not finish within 3600000ms",
    );
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");
  });

  it("refuses to touch a letter twice, or one that is not there", async () => {
    policyMode = "domain";
    const { harness, deadLetters, entries } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    const id = letter?.id ?? "";

    expect(await deadLetters.discard(id)).toMatchObject({ id, status: "discarded" });
    expect(entries).toContainEqual({
      level: "info",
      message: "dead letter discarded",
      fields: { id, kind: "policy", handler: "order.notifyOnOrderPlaced" },
    });
    await expect(deadLetters.retry(id)).rejects.toThrow(
      new DeadLetterSettledError({ id, status: "discarded" }),
    );
    await expect(deadLetters.discard(id)).rejects.toBeInstanceOf(DeadLetterSettledError);
    await expect(deadLetters.retry("nope")).rejects.toThrow(
      new NotFoundError('Dead letter "nope" not found'),
    );
    await expect(deadLetters.discard("nope")).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toEqual(["notify:o-1"]);
  });

  it("lets one of two concurrent retries of a policy letter through, and the other writes nothing", async () => {
    policyMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    const id = letter?.id ?? "";
    policyMode = "ok";
    calls.length = 0;

    const outcomes = await Promise.allSettled([deadLetters.retry(id), deadLetters.retry(id)]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const [rejected] = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(DeadLetterSettledError);
    expect(calls).toEqual(["notify:o-1", "notify:o-1"]);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(events.map((event) => event.type)).toEqual(["OrderPlaced", "OrderArchived"]);
    expect((await deadLetters.get(id))?.status).toBe("retried");
  });

  it("lets one of two concurrent retries of a scheduled command letter through, deciding the command once", async () => {
    policyMode = "ok";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    await harness.worker.runOnce();
    const [letter] = await deadLetters.list({ kind: "scheduled" });
    const id = letter?.id ?? "";
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });

    const outcomes = await Promise.allSettled([deadLetters.retry(id), deadLetters.retry(id)]);

    const [rejected] = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(DeadLetterSettledError);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(events.filter((event) => event.type === "OrderPaid")).toHaveLength(1);
    expect((await deadLetters.get(id))?.status).toBe("retried");
  });

  it("keeps a letter discarded while its retry ran, and the retry writes nothing", async () => {
    policyMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    const id = letter?.id ?? "";
    policyMode = "waits";
    handlerStarted = Promise.withResolvers<void>();
    gate = Promise.withResolvers<void>();

    const retrying = deadLetters.retry(id);
    await handlerStarted.promise;
    expect(await deadLetters.discard(id)).toMatchObject({ status: "discarded" });
    gate.resolve();

    await expect(retrying).rejects.toBeInstanceOf(DeadLetterSettledError);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(events.map((event) => event.type)).toEqual(["OrderPlaced"]);
    expect((await deadLetters.get(id))?.status).toBe("discarded");
  });

  describe("a retry that meets a conflict", () => {
    const conflicted = async (
      afterTheConflict: (
        args: Awaited<ReturnType<typeof setUp>> & { id: string },
      ) => Promise<unknown>,
    ) => {
      policyMode = "domain";
      const set = await setUp();
      const { harness, deadLetters } = set;
      await harness.pipeline.dispatch({
        type: "PlaceOrder",
        payload: { orderId: "o-1", total: 10 },
      });
      await harness.dispatcher.runUntilIdle();
      const [letter] = await deadLetters.list();
      const id = letter?.id ?? "";
      policyMode = "ok";
      calls.length = 0;
      const transact = harness.storage.transact.bind(harness.storage);
      harness.storage.transact = async (work) => {
        harness.storage.transact = transact;
        await harness.pipeline.dispatch({
          type: "PayOrder",
          payload: { orderId: "o-1", method: "card" },
        });
        try {
          return await transact(work);
        } catch (error) {
          await afterTheConflict({ ...set, id });
          throw error;
        }
      };
      const types = async (): Promise<readonly string[]> =>
        (
          await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
        ).events.map((event) => event.type);
      return { harness, deadLetters, id, types };
    };

    it("runs again on the new state while the letter is still failed", async () => {
      const { deadLetters, id, types } = await conflicted(async () => undefined);

      expect((await deadLetters.retry(id)).status).toBe("retried");

      expect(calls).toEqual(["notify:o-1", "notify:o-1"]);
      expect(await types()).toEqual(["OrderPlaced", "OrderPaid", "OrderArchived"]);
    });

    it("does not run again once the letter was settled", async () => {
      const { deadLetters, id, types } = await conflicted(({ deadLetters, id }) =>
        deadLetters.discard(id),
      );

      await expect(deadLetters.retry(id)).rejects.toThrow(new DeadLetterSettledError({ id }));

      expect(calls).toEqual(["notify:o-1"]);
      expect(await types()).toEqual(["OrderPlaced", "OrderPaid"]);
      expect((await deadLetters.get(id))?.status).toBe("discarded");
    });

    it("does not run again once the letter is gone", async () => {
      const { deadLetters, id } = await conflicted(({ harness, id }) =>
        harness.storage.deadLetterStore.remove(id),
      );

      await expect(deadLetters.retry(id)).rejects.toBeInstanceOf(DeadLetterSettledError);

      expect(calls).toEqual(["notify:o-1"]);
    });
  });

  it("does not discard a letter a retry settled first", async () => {
    policyMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    const id = letter?.id ?? "";
    policyMode = "ok";
    const get = harness.storage.deadLetterStore.get.bind(harness.storage.deadLetterStore);
    harness.storage.deadLetterStore.get = async (letterId) => {
      const read = await get(letterId);
      harness.storage.deadLetterStore.get = get;
      await deadLetters.retry(id);
      return read;
    };

    await expect(deadLetters.discard(id)).rejects.toBeInstanceOf(DeadLetterSettledError);
    expect((await deadLetters.get(id))?.status).toBe("retried");
  });

  it("retries a process handler, reopens the failed process and schedules its deadlines again", async () => {
    policyMode = "ok";
    processMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(3_600_000);
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list({ kind: "process" });
    expect(letter).toMatchObject({ handler: "order.orderPayment", eventType: "OrderPaid" });
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const stream = { aggregateType: "process:order.orderPayment", aggregateId: "o-1" };
    expect(
      (await harness.storage.eventStore.load(stream)).events.map((event) => event.type),
    ).toEqual([PROCESS_EVENTS.started, PROCESS_EVENTS.failed]);

    processMode = "ok";
    expect((await deadLetters.retry(letter?.id ?? "")).status).toBe("retried");
    expect(calls.filter((call) => call.startsWith("paid:"))).toEqual(["paid:card", "paid:card"]);
    const processKeys = keys.filter((key) => key.startsWith("process "));
    expect(processKeys[0]).toBe(
      `process ${deriveIdempotencyKey({ kind: "process", handler: "order.orderPayment", subject: letter?.eventId ?? "" })}`,
    );
    expect(new Set(processKeys).size).toBe(2);
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

  it("keeps a process letter discarded while its retry ran, and says the retry was refused", async () => {
    policyMode = "ok";
    processMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list({ kind: "process" });
    const id = letter?.id ?? "";
    processMode = "ok";
    const transact = harness.storage.transact.bind(harness.storage);
    harness.storage.transact = async (work) => {
      harness.storage.transact = transact;
      await deadLetters.discard(id);
      return transact(work);
    };

    await expect(deadLetters.retry(id)).rejects.toBeInstanceOf(DeadLetterSettledError);

    expect((await deadLetters.get(id))?.status).toBe("discarded");
  });

  it("schedules the timeout again at its moment when the process stays open", async () => {
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
                config: ({ events }: OrderProcessConfigArgs<"OrderPlaced" | "OrderArchived">) => ({
                  startedBy: [events.order.OrderPlaced],
                  completedBy: [events.order.OrderArchived],
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
      pipeline: harness.pipeline,
      aggregates: harness.aggregates,
      policies: harness.policies,
      policyExecutor: harness.policyExecutor,
      processes: harness.processes,
      config: harness.config,
      ids: harness.ids,
      clock: harness.clock,
      logger,
    });
    const startedAt = harness.clock.now().getTime();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(3_600_000);
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.runUntilIdle();
    expect(await harness.storage.scheduler.list()).toEqual([]);

    processMode = "ok";
    const [letter] = await deadLetters.list({ kind: "process" });
    await deadLetters.retry(letter?.id ?? "");
    expect(await harness.storage.scheduler.list()).toMatchObject([
      {
        dedupeKey: "process-deadline:order.orderPayment:o-1",
        executeAt: new Date(startedAt + 48 * 3_600_000).toISOString(),
      },
    ]);

    harness.clock.advance(49 * 3_600_000);
    const late = await deadLetters.list({ kind: "process" });
    expect(late).toHaveLength(1);
  });

  it("schedules an overdue timeout at its moment, so it runs at once", async () => {
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
                config: ({ events }: OrderProcessConfigArgs<"OrderPlaced" | "OrderArchived">) => ({
                  startedBy: [events.order.OrderPlaced],
                  completedBy: [events.order.OrderArchived],
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
      pipeline: harness.pipeline,
      aggregates: harness.aggregates,
      policies: harness.policies,
      policyExecutor: harness.policyExecutor,
      processes: harness.processes,
      config: harness.config,
      ids: harness.ids,
      clock: harness.clock,
      logger: harness.logger,
    });
    const startedAt = harness.clock.now().getTime();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(5 * 3_600_000);
    processMode = "ok";
    const [letter] = await deadLetters.list({ kind: "process" });
    await deadLetters.retry(letter?.id ?? "");
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { executeAt: new Date(startedAt + 3_600_000).toISOString() },
    ]);
    await harness.dispatcher.runUntilIdle();
    expect(await harness.worker.runOnce()).toBe(1);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "process:order.orderPayment",
      aggregateId: "o-1",
    });
    expect(events.at(-1)?.type).toBe(PROCESS_EVENTS.timedOut);
  });

  it("settles a dropped command that its aggregate now rejects, as the scheduler would have", async () => {
    policyMode = "ok";
    const { harness, deadLetters, entries } = await setUp();
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "transfer" },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    await harness.worker.runOnce();
    const [letter] = await deadLetters.list({ kind: "scheduled" });
    expect(letter).toMatchObject({
      eventType: "PayOrder",
      payload: { orderId: "o-1", method: "transfer" },
    });

    paymentsClosed = true;
    await expect(deadLetters.retry(letter?.id ?? "")).resolves.toMatchObject({
      status: "retried",
    });
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("retried");
    expect(entries).toContainEqual({
      level: "info",
      message: "command rejected",
      fields: expect.objectContaining({ type: "PayOrder", rejected: "Closed" }),
    });
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(events.map((event) => event.type)).not.toContain("OrderPaid");
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
    const [letter] = await deadLetters.list({ kind: "scheduled" });
    expect(letter).toMatchObject({
      eventType: "PayOrder",
      errorMessage: "Only placed orders can be paid",
    });

    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    expect((await deadLetters.retry(letter?.id ?? "")).status).toBe("retried");
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = events.find((event) => event.type === "OrderPaid");
    expect(paid?.payload).toEqual({ method: "card" });
    expect(paid?.metadata).toMatchObject({ depth: 0 });
    expect(paid?.metadata.correlationId).toEqual(expect.any(String));
  });

  it("refuses a scheduled command letter whose command is gone, and a letter of an unknown kind", async () => {
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
      payload: { orderId: "o-1" },
    };
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "gone",
      kind: "scheduled",
      handler: "ForgetOrder",
      eventType: "ForgetOrder",
    });
    await expect(deadLetters.retry("gone")).rejects.toThrow(
      new DeadLetterNotRetriableError('Command "ForgetOrder" is no longer in the registry'),
    );
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "old",
      kind: "command" as never,
      handler: "PlaceOrder",
      eventType: "PlaceOrder",
    });
    await expect(deadLetters.retry("old")).rejects.toThrow(
      new DeadLetterNotRetriableError('Dead letter "old" has an unknown kind "command"'),
    );
    expect((await deadLetters.get("old"))?.status).toBe("failed");
  });

  it("fails the process on a deadline that gives up, and retries it with a new key", async () => {
    policyMode = "ok";
    timeoutMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-9", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(48 * 3_600_000);
    expect(await harness.worker.runOnce()).toBe(1);
    const stream = { aggregateType: "process:order.orderPayment", aggregateId: "o-9" };
    expect(
      (await harness.storage.eventStore.load(stream)).events.map((event) => event.type),
    ).toEqual([PROCESS_EVENTS.started, PROCESS_EVENTS.failed]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const [letter] = await deadLetters.list({ kind: "process" });
    expect(letter).toMatchObject({
      handler: "order.orderPayment",
      eventId: "deadline:timeout",
      eventType: PROCESS_DEADLINE_COMMAND,
      aggregateType: "process:order.orderPayment",
      aggregateId: "o-9",
      errorType: "terminal",
      errorMessage: "courier is closed",
    });

    timeoutMode = "ok";
    expect((await deadLetters.retry(letter?.id ?? "")).status).toBe("retried");
    const timeoutKeys = keys.filter((key) => key.startsWith("timeout "));
    expect(timeoutKeys).toHaveLength(2);
    expect(new Set(timeoutKeys).size).toBe(2);
    expect(
      (await harness.storage.eventStore.load(stream)).events.map((event) => event.type),
    ).toEqual([PROCESS_EVENTS.started, PROCESS_EVENTS.failed, PROCESS_EVENTS.timedOut]);
    const retried = (await harness.storage.eventStore.load(stream)).events;
    expect(retried.at(-1)?.metadata).toMatchObject({
      causationId: letter?.id,
      depth: 0,
      correlationId: retried[0]?.metadata.correlationId,
    });
    await expect(deadLetters.retry(letter?.id ?? "")).rejects.toThrow("already retried");
  });

  it("refuses to retry a deadline of a process that did not fail on one", async () => {
    policyMode = "ok";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-9", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    await harness.storage.deadLetterStore.add({
      id: "d",
      kind: "process",
      handler: "order.orderPayment",
      eventId: "deadline:timeout",
      eventType: PROCESS_DEADLINE_COMMAND,
      aggregateType: "process:order.orderPayment",
      aggregateId: "o-9",
      errorType: "terminal",
      errorMessage: "x",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(deadLetters.retry("d")).rejects.toThrow(
      'Process "order.orderPayment" has no failed deadline for o-9',
    );
    await harness.storage.deadLetterStore.add({
      id: "gone",
      kind: "process",
      handler: "order.gone",
      eventId: "deadline:timeout",
      eventType: PROCESS_DEADLINE_COMMAND,
      aggregateType: "process:order.gone",
      aggregateId: "o-9",
      errorType: "terminal",
      errorMessage: "x",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(deadLetters.retry("gone")).rejects.toThrow(
      new DeadLetterNotRetriableError('Process "order.gone" is no longer in the registry'),
    );
  });

  it("names a policy or process the registry no longer has or that no longer handles the event, and an event that is gone", async () => {
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
      handler: "order.gone",
    });
    await expect(deadLetters.retry("p")).rejects.toThrow(
      new DeadLetterNotRetriableError('Policy "order.gone" is no longer in the registry'),
    );
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "e",
      kind: "policy",
      handler: "order.notifyOnOrderPlaced",
    });
    await expect(deadLetters.retry("e")).rejects.toThrow(
      new NotFoundError("Event missing-event of order:o-1 not found"),
    );
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    const [placed] = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events;
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    const paid = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events.find((event) => event.type === "OrderPaid");
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "pn",
      kind: "policy",
      handler: "order.notifyOnOrderPlaced",
      eventId: paid?.id ?? "",
      eventType: "OrderPaid",
    });
    await expect(deadLetters.retry("pn")).rejects.toThrow(
      new DeadLetterNotRetriableError(
        'Policy "order.notifyOnOrderPlaced" no longer handles order.OrderPaid',
      ),
    );
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "pr",
      kind: "process",
      handler: "order.gone",
      eventId: placed?.id ?? "",
    });
    await expect(deadLetters.retry("pr")).rejects.toThrow(
      new DeadLetterNotRetriableError('Process "order.gone" is no longer in the registry'),
    );
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "ph",
      kind: "process",
      handler: "order.orderPayment",
      eventId: placed?.id ?? "",
    });
    await expect(deadLetters.retry("ph")).rejects.toThrow(
      new DeadLetterNotRetriableError('Process "order.orderPayment" no longer handles OrderPlaced'),
    );
    await harness.storage.deadLetterStore.add({
      ...base,
      id: "pi",
      kind: "process",
      handler: "order.orderPayment",
      eventType: "OrderPaid",
      aggregateId: "o-2",
      eventId: "e-none",
    });
    await expect(deadLetters.retry("pi")).rejects.toBeInstanceOf(NotFoundError);
  });
});
