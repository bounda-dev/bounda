import { describe, expect, it } from "vitest";
import { DeadLetterSettledError, NotFoundError, ValidationError } from "../../contracts/errors.ts";
import type { RejectFunction } from "../../modules/command.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { PROCESS_DEADLINE_COMMAND } from "../process/deadlines.ts";
import { PROCESS_EVENTS } from "../process/lifecycle.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { COMMAND_FAILED_EVENT } from "../system-events.ts";
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

// A delayed command is dropped to a dead letter when it fails, never when it is rejected.
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
      collaborators: {
        ...order.collaborators,
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
  it("replays a policy for its stored event and marks the letter replayed", async () => {
    policyMode = "domain";
    const { harness, deadLetters, entries } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({ kind: "policy", subscriber: "order.notifyOnOrderPlaced" });
    expect(await deadLetters.count({ status: "failed" })).toBe(1);
    expect(calls).toEqual(["notify:o-1"]);

    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow("mail server rejects it");
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");

    policyMode = "ok";
    const telemetry = installFakeTelemetry();
    expect(await deadLetters.replay(letter?.id ?? "")).toMatchObject({
      id: letter?.id,
      status: "replayed",
    });
    expect(
      telemetry.spans.find((span) => span.name === "bounda.policy order.notifyOnOrderPlaced"),
    ).toMatchObject({ attributes: { [ATTRIBUTES.attempt]: 2 } });
    telemetry.restore();
    expect(calls).toEqual(["notify:o-1", "notify:o-1", "notify:o-1"]);
    const live = `policy ${deriveIdempotencyKey({ kind: "policy", handler: "order.notifyOnOrderPlaced", subject: letter?.eventId ?? "" })}`;
    expect(keys[0]).toBe(live);
    expect(new Set(keys).size).toBe(3);
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

  it("marks a policy letter replayed together with the replay's writes, or neither", async () => {
    policyMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    policyMode = "ok";
    const crash = breakNextCommit(harness.storage);

    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow("connection lost");
    expect(crash.broke()).toBe(true);
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");
    const order = { aggregateType: "order", aggregateId: "o-1" };
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual(["OrderPlaced"]);

    expect((await deadLetters.replay(letter?.id ?? "")).status).toBe("replayed");
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual(["OrderPlaced", "OrderArchived"]);
    expect(calls).toEqual(["notify:o-1", "notify:o-1", "notify:o-1"]);
  });

  it("marks a command letter replayed together with the command's events, or neither", async () => {
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
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    const crash = breakNextCommit(harness.storage);

    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow("connection lost");
    expect(crash.broke()).toBe(true);
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");
    const order = { aggregateType: "order", aggregateId: "o-1" };
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual([COMMAND_FAILED_EVENT, "OrderPlaced"]);

    expect((await deadLetters.replay(letter?.id ?? "")).status).toBe("replayed");
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual([COMMAND_FAILED_EVENT, "OrderPlaced", "OrderPaid"]);
  });

  it("gives a replayed policy the same time budget as a live one, naming it", async () => {
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
    const replaying = deadLetters.replay(letter?.id ?? "");
    await handlerStarted.promise;
    harness.clock.advance(3_600_000);
    await expect(replaying).rejects.toThrow(
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
      fields: { id, kind: "policy", subscriber: "order.notifyOnOrderPlaced" },
    });
    await expect(deadLetters.replay(id)).rejects.toThrow(
      new DeadLetterSettledError({ id, status: "discarded" }),
    );
    await expect(deadLetters.discard(id)).rejects.toBeInstanceOf(DeadLetterSettledError);
    await expect(deadLetters.replay("nope")).rejects.toThrow(
      new NotFoundError('Dead letter "nope" not found'),
    );
    await expect(deadLetters.discard("nope")).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toEqual(["notify:o-1"]);
  });

  it("lets one of two concurrent replays of a policy letter through, and the other writes nothing", async () => {
    policyMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    const id = letter?.id ?? "";
    policyMode = "ok";
    calls.length = 0;

    const outcomes = await Promise.allSettled([deadLetters.replay(id), deadLetters.replay(id)]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const [rejected] = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(DeadLetterSettledError);
    expect(calls).toEqual(["notify:o-1", "notify:o-1"]);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(events.map((event) => event.type)).toEqual(["OrderPlaced", "OrderArchived"]);
    expect((await deadLetters.get(id))?.status).toBe("replayed");
  });

  it("lets one of two concurrent replays of a command letter through, deciding the command once", async () => {
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
    const id = letter?.id ?? "";
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });

    const outcomes = await Promise.allSettled([deadLetters.replay(id), deadLetters.replay(id)]);

    const [rejected] = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(DeadLetterSettledError);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(events.filter((event) => event.type === "OrderPaid")).toHaveLength(1);
    expect((await deadLetters.get(id))?.status).toBe("replayed");
  });

  it("keeps a letter discarded while its replay ran, and the replay writes nothing", async () => {
    policyMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    const id = letter?.id ?? "";
    policyMode = "waits";
    handlerStarted = Promise.withResolvers<void>();
    gate = Promise.withResolvers<void>();

    const replaying = deadLetters.replay(id);
    await handlerStarted.promise;
    expect(await deadLetters.discard(id)).toMatchObject({ status: "discarded" });
    gate.resolve();

    await expect(replaying).rejects.toBeInstanceOf(DeadLetterSettledError);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(events.map((event) => event.type)).toEqual(["OrderPlaced"]);
    expect((await deadLetters.get(id))?.status).toBe("discarded");
  });

  describe("a replay that meets a conflict", () => {
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

      expect((await deadLetters.replay(id)).status).toBe("replayed");

      expect(calls).toEqual(["notify:o-1", "notify:o-1"]);
      expect(await types()).toEqual(["OrderPlaced", "OrderPaid", "OrderArchived"]);
    });

    it("does not run again once the letter was settled", async () => {
      const { deadLetters, id, types } = await conflicted(({ deadLetters, id }) =>
        deadLetters.discard(id),
      );

      await expect(deadLetters.replay(id)).rejects.toThrow(new DeadLetterSettledError({ id }));

      expect(calls).toEqual(["notify:o-1"]);
      expect(await types()).toEqual(["OrderPlaced", "OrderPaid"]);
      expect((await deadLetters.get(id))?.status).toBe("discarded");
    });

    it("does not run again once the letter is gone", async () => {
      const { deadLetters, id } = await conflicted(({ harness, id }) =>
        harness.storage.deadLetterStore.remove(id),
      );

      await expect(deadLetters.replay(id)).rejects.toBeInstanceOf(DeadLetterSettledError);

      expect(calls).toEqual(["notify:o-1"]);
    });
  });

  it("does not discard a letter a replay settled first", async () => {
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
      await deadLetters.replay(id);
      return read;
    };

    await expect(deadLetters.discard(id)).rejects.toBeInstanceOf(DeadLetterSettledError);
    expect((await deadLetters.get(id))?.status).toBe("replayed");
  });

  it("replays a process handler, reopens the failed process and schedules its deadlines again", async () => {
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
    expect(letter).toMatchObject({ subscriber: "order.orderPayment", eventType: "OrderPaid" });
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const stream = { aggregateType: "process:OrderPayment", aggregateId: "o-1" };
    expect(
      (await harness.storage.eventStore.load(stream)).events.map((event) => event.type),
    ).toEqual([PROCESS_EVENTS.started, PROCESS_EVENTS.failed]);

    processMode = "ok";
    expect((await deadLetters.replay(letter?.id ?? "")).status).toBe("replayed");
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

  it("keeps a process letter discarded while its replay ran, and says the replay was refused", async () => {
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

    await expect(deadLetters.replay(id)).rejects.toBeInstanceOf(DeadLetterSettledError);

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
    await deadLetters.replay(letter?.id ?? "");
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
    await deadLetters.replay(letter?.id ?? "");
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { executeAt: new Date(startedAt + 3_600_000).toISOString() },
    ]);
    await harness.dispatcher.runUntilIdle();
    expect(await harness.worker.runOnce()).toBe(1);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "process:OrderPayment",
      aggregateId: "o-1",
    });
    expect(events.at(-1)?.type).toBe(PROCESS_EVENTS.timedOut);
  });

  it("dispatches a dropped command again with its recorded payload, throwing its rejection", async () => {
    policyMode = "ok";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "transfer" },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    await harness.worker.runOnce();
    const [letter] = await deadLetters.list({ kind: "command" });
    expect(letter).toMatchObject({
      eventType: "PayOrder",
      payload: { orderId: "o-1", method: "transfer" },
    });

    paymentsClosed = true;
    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toMatchObject({
      name: "DomainError",
      rejected: "Closed",
      message: "Payments are closed",
    });
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");
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

  it("fails the process on a deadline that gives up, and replays it with a new key", async () => {
    policyMode = "ok";
    timeoutMode = "domain";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-9", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(48 * 3_600_000);
    expect(await harness.worker.runOnce()).toBe(1);
    const stream = { aggregateType: "process:OrderPayment", aggregateId: "o-9" };
    expect(
      (await harness.storage.eventStore.load(stream)).events.map((event) => event.type),
    ).toEqual([PROCESS_EVENTS.started, PROCESS_EVENTS.failed]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const [letter] = await deadLetters.list({ kind: "process" });
    expect(letter).toMatchObject({
      subscriber: "order.orderPayment",
      eventId: "deadline:timeout",
      eventType: PROCESS_DEADLINE_COMMAND,
      aggregateType: "process:OrderPayment",
      aggregateId: "o-9",
      errorType: "terminal",
      errorMessage: "courier is closed",
    });

    timeoutMode = "ok";
    expect((await deadLetters.replay(letter?.id ?? "")).status).toBe("replayed");
    const timeoutKeys = keys.filter((key) => key.startsWith("timeout "));
    expect(timeoutKeys).toHaveLength(2);
    expect(new Set(timeoutKeys).size).toBe(2);
    expect(
      (await harness.storage.eventStore.load(stream)).events.map((event) => event.type),
    ).toEqual([PROCESS_EVENTS.started, PROCESS_EVENTS.failed, PROCESS_EVENTS.timedOut]);
    const replayed = (await harness.storage.eventStore.load(stream)).events;
    expect(replayed.at(-1)?.metadata).toMatchObject({
      causationId: letter?.id,
      depth: 0,
      correlationId: replayed[0]?.metadata.correlationId,
    });
    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow("already replayed");
  });

  it("refuses to replay a deadline of a process that did not fail on one", async () => {
    policyMode = "ok";
    const { harness, deadLetters } = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-9", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    await harness.storage.deadLetterStore.add({
      id: "d",
      kind: "process",
      subscriber: "order.orderPayment",
      eventId: "deadline:timeout",
      eventType: PROCESS_DEADLINE_COMMAND,
      aggregateType: "process:OrderPayment",
      aggregateId: "o-9",
      errorType: "terminal",
      errorMessage: "x",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(deadLetters.replay("d")).rejects.toThrow(
      'Process "order.orderPayment" has no failed deadline for o-9',
    );
    await harness.storage.deadLetterStore.add({
      id: "gone",
      kind: "process",
      subscriber: "order.gone",
      eventId: "deadline:timeout",
      eventType: PROCESS_DEADLINE_COMMAND,
      aggregateType: "process:Gone",
      aggregateId: "o-9",
      errorType: "terminal",
      errorMessage: "x",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(deadLetters.replay("gone")).rejects.toThrow(
      'Process "order.gone" is no longer in the registry',
    );
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
