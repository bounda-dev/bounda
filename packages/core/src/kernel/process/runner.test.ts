import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config/schema.ts";
import { DomainError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import {
  createRecordingLogger,
  type OrderProcessConfigArgs,
  orderAggregateEntry,
} from "../test-support.ts";
import { buildProcesses } from "./build-processes.ts";
import { PROCESS_EVENTS } from "./lifecycle.ts";
import { PROCESS_DEADLINE_COMMAND } from "./runner.ts";

interface HandlerArgs {
  readonly event: { aggregateId: string; payload: { method?: string } };
  readonly state: { reminders: number; method: string | null };
  readonly aggregateId: string;
  readonly commands: Record<string, (payload: unknown) => Promise<unknown>>;
}

const calls: string[] = [];
let mode: "ok" | "domain" | "flaky" | "void" = "ok";
let flakyFailures = 0;

const registry: Registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      processes: {
        orderPayment: {
          module: {
            config: ({
              events,
            }: OrderProcessConfigArgs<"OrderPlaced" | "OrderPaid" | "OrderArchived">) => ({
              startedBy: [events.order.OrderPlaced],
              completedBy: [events.order.OrderPaid, events.order.OrderArchived],
              timeout: "48h",
            }),
            state: ({ z }: PayloadArgs) =>
              z.object({
                reminders: z.int().default(0),
                method: z.string().nullable().default(null),
              }),
          },
          handlers: {
            order: {
              orderPaid: {
                handler: ({ event, state }: HandlerArgs) => {
                  calls.push(`paid:${event.aggregateId}`);
                  if (mode === "domain") throw new DomainError("bad payment");
                  if (mode === "void") return undefined;
                  if (mode === "flaky" && flakyFailures > 0) {
                    flakyFailures -= 1;
                    throw new Error("network");
                  }
                  return { ...state, method: event.payload.method ?? null };
                },
              },
            },
          },
          deadlines: {
            timeout: {
              handler: async ({ state, aggregateId, commands }: HandlerArgs) => {
                calls.push(`timeout:${aggregateId}`);
                await commands.archiveOrder?.({ orderId: aggregateId });
                return { ...state, reminders: state.reminders + 1 };
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
};

const reset = (next: typeof mode, failures = 0) => {
  calls.length = 0;
  mode = next;
  flakyFailures = failures;
};

const processStream = (harness: Awaited<ReturnType<typeof createReactiveHarness>>, id = "o-1") =>
  harness.storage.eventStore.load({ aggregateType: "process:OrderPayment", aggregateId: id });

describe("buildProcesses", () => {
  const config = resolveConfig({
    storage: memory(),
    commands: { placeOrder: { notifier: { use: "memory" } } },
  });

  it("compiles config, state defaults, handlers and timeout", () => {
    const { all, byEvent } = buildProcesses({ registry, config });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      name: "order.orderPayment",
      type: "OrderPayment",
      timeoutMs: 172_800_000,
      initialState: { reminders: 0, method: null },
    });
    expect([...(all[0]?.startedBy ?? [])]).toEqual(["order.OrderPlaced"]);
    expect(Object.keys(all[0]?.handlers ?? {})).toEqual(["order.OrderPaid"]);
    expect(Object.keys(byEvent).sort()).toEqual([
      "order.OrderArchived",
      "order.OrderPaid",
      "order.OrderPlaced",
    ]);
  });

  it("falls back to the configured default timeout", () => {
    const withoutTimeout: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            quick: {
              module: { config: () => ({ startedBy: ["order.OrderPlaced"] }) },
              handlers: {},
            },
          },
        },
      },
      readModels: {},
    };
    const built = buildProcesses({
      registry: withoutTimeout,
      config: resolveConfig({ storage: memory(), runtime: { processes: { timeout: "1h" } } }),
    });
    expect(built.all[0]?.timeoutMs).toBe(3_600_000);
    expect(built.all[0]).toMatchObject({
      initialState: {},
      stateSchema: null,
      deadlineFields: [],
      deadlineHandlers: {},
    });
  });

  it("rejects state factories that do not return a schema and handlers for unknown events", () => {
    const badStateShape: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            p: {
              module: {
                config: () => ({ startedBy: ["order.OrderPlaced"] }),
                state: (() => "nope") as never,
              },
              handlers: {},
            },
          },
        },
      },
      readModels: {},
    };
    expect(() => buildProcesses({ registry: badStateShape, config })).toThrow(
      "aggregates.order.processes.p: state must return a Zod schema",
    );
    const badHandler: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            p: {
              module: { config: () => ({ startedBy: ["order.OrderPlaced"] }) },
              handlers: { order: { orderShipped: { handler: () => undefined } } },
            },
          },
        },
      },
      readModels: {},
    };
    expect(() => buildProcesses({ registry: badHandler, config })).toThrow(
      'aggregates.order.processes.p.handlers.order.orderShipped: "order.OrderShipped" is not an event of the app',
    );
  });

  it("rejects unknown events and state schemas without defaults", () => {
    const badEvent: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            p: { module: { config: () => ({ startedBy: ["order.OrderShipped"] }) }, handlers: {} },
          },
        },
      },
      readModels: {},
    };
    expect(() => buildProcesses({ registry: badEvent, config })).toThrow(
      'aggregates.order.processes.p: "order.OrderShipped" is not an event of the app; name events as events.<aggregate>.<Event>',
    );
    const badState: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            p: {
              module: {
                config: () => ({ startedBy: ["order.OrderPlaced"] }),
                state: ({ z }: PayloadArgs) => z.object({ required: z.string() }),
              },
              handlers: {},
            },
          },
        },
      },
      readModels: {},
    };
    expect(() => buildProcesses({ registry: badState, config })).toThrow(
      /must accept an empty object/,
    );
  });
});

describe("process runner", () => {
  it("starts on the starting event, handles, completes and cancels the timeout", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();

    let stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([PROCESS_EVENTS.started]);
    expect(stream.events[0]?.metadata.system).toBe(true);
    const timeoutAt = new Date(harness.clock.now().getTime() + 172_800_000).toISOString();
    expect(stream.events[0]?.payload).toMatchObject({ timeoutAt });
    expect((await harness.storage.scheduler.list()).map((entry) => entry.dedupeKey)).toEqual([
      "process-deadline:order.orderPayment:o-1",
    ]);
    expect((await harness.storage.scheduler.list())[0]).toMatchObject({
      executeAt: timeoutAt,
      command: {
        type: "bounda.ProcessDeadline",
        aggregateId: "o-1",
        payload: {
          process: "order.orderPayment",
          aggregateId: "o-1",
          field: "timeout",
          at: timeoutAt,
        },
      },
      context: { correlationId: stream.events[0]?.metadata.correlationId, depth: 0 },
    });
    expect(PROCESS_DEADLINE_COMMAND).toBe("bounda.ProcessDeadline");

    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(stream.events[1]?.payload).toMatchObject({
      state: { reminders: 0, method: "card" },
      eventType: "OrderPaid",
    });
    expect(calls).toEqual(["paid:o-1"]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("ignores events for instances that never started or already finished", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-2" } });
    await harness.dispatcher.processUntilIdle();
    expect((await processStream(harness, "o-2")).events).toEqual([]);

    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await harness.dispatcher.processUntilIdle();
    await harness.pipeline
      .dispatch({ type: "PayOrder", payload: { orderId: "o-1", method: "card" } })
      .catch(() => undefined);
    await harness.dispatcher.processUntilIdle();
    const stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.completed,
    ]);
    expect(calls).toEqual([]);
  });

  it("runs the timeout handler when the schedule comes due and records the final state", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();

    expect(await harness.worker.runOnce()).toBe(0);
    harness.clock.advance(172_800_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(calls).toEqual(["timeout:o-1"]);

    const stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
    ]);
    expect(stream.events[1]?.payload).toEqual({ state: { reminders: 1, method: null } });
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(order.events.map((event) => event.type)).toEqual(["OrderPlaced", "OrderArchived"]);
    expect(order.events[1]?.metadata.depth).toBe(1);
    expect(await harness.storage.scheduler.list()).toEqual([]);

    await harness.dispatcher.processUntilIdle();
    expect((await processStream(harness)).events).toHaveLength(2);
  });

  it("records a terminal failure, dead-letters it and cancels the timeout", async () => {
    reset("domain");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();

    const stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
    ]);
    expect(stream.events[1]?.payload).toEqual({
      eventId: expect.any(String),
      error: "bad payment",
    });
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        kind: "process",
        subscriber: "order.orderPayment",
        errorType: "terminal",
        errorMessage: "bad payment",
        errorStack: expect.stringContaining("bad payment"),
      },
    ]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("retries retriable failures across passes with back-off and recovers", async () => {
    reset("flaky", 1);
    const harness = await createReactiveHarness({
      registry,
      config: {
        runtime: { processes: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "1s" } } },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    expect(calls).toEqual(["paid:o-1"]);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(0);

    await harness.dispatcher.processUntilIdle();
    expect(calls).toEqual(["paid:o-1"]);

    harness.clock.advance(1_000);
    await harness.dispatcher.processUntilIdle();
    expect(calls).toEqual(["paid:o-1", "paid:o-1"]);
    const stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("handles each instance independently", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-2", total: 20 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-2", method: "transfer" },
    });
    await harness.dispatcher.processUntilIdle();
    expect((await processStream(harness, "o-1")).events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
    ]);
    expect((await processStream(harness, "o-2")).events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect((await harness.storage.scheduler.list()).map((entry) => entry.dedupeKey)).toEqual([
      "process-deadline:order.orderPayment:o-1",
    ]);
  });

  it("runs the handler declared for the starting event exactly once", async () => {
    const totals: number[] = [];
    const startHandled: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            orderTotals: {
              module: {
                config: ({ events }: OrderProcessConfigArgs<"OrderPlaced" | "OrderPaid">) => ({
                  startedBy: [events.order.OrderPlaced],
                  completedBy: [events.order.OrderPaid],
                }),
                state: ({ z }: PayloadArgs) => z.object({ total: z.number().default(0) }),
              },
              handlers: {
                order: {
                  orderPlaced: {
                    handler: ({
                      event,
                      state,
                    }: {
                      event: { payload: { total: number } };
                      state: { total: number };
                    }) => {
                      totals.push(event.payload.total);
                      return { ...state, total: event.payload.total };
                    },
                  },
                },
              },
            },
          },
        },
      },
      readModels: {},
    };
    const harness = await createReactiveHarness({ registry: startHandled });
    const load = () =>
      harness.storage.eventStore.load({ aggregateType: "process:OrderTotals", aggregateId: "o-1" });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    let stream = await load();
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
    ]);
    expect(stream.events[1]?.payload).toMatchObject({
      state: { total: 10 },
      eventType: "OrderPlaced",
    });
    expect(totals).toEqual([10]);

    await harness.storage.checkpointStore.set("processes", 0);
    await harness.dispatcher.processUntilIdle();
    stream = await load();
    expect(stream.events).toHaveLength(2);
    expect(totals).toEqual([10]);
  });

  it("keeps the state when a handler returns nothing", async () => {
    reset("void");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    const stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(stream.events[1]?.payload).toEqual({
      state: { reminders: 0, method: null },
      eventId: expect.any(String),
      eventType: "OrderPaid",
    });
  });

  it("dead-letters a retriable failure once the configured attempts are used up", async () => {
    reset("flaky", 5);
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({
      registry,
      logger,
      config: {
        runtime: { processes: { retry: { strategy: "fixed", maxAttempts: 2, baseDelay: "1s" } } },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    expect(calls).toEqual(["paid:o-1"]);
    expect(entries).toEqual([
      {
        level: "warn",
        message: "process handler failed; will retry",
        fields: { process: "order.orderPayment", eventId: expect.any(String), attempts: 1 },
      },
    ]);

    harness.clock.advance(1_000);
    await harness.dispatcher.processUntilIdle();
    expect(calls).toEqual(["paid:o-1", "paid:o-1"]);
    const stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
    ]);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        kind: "process",
        errorType: "retriable_exhausted",
        attempts: 2,
        errorMessage: "network",
        errorStack: expect.stringContaining("network"),
      },
    ]);
    expect(entries[1]).toEqual({
      level: "warn",
      message: "process dead-lettered",
      fields: {
        process: "order.orderPayment",
        eventId: expect.any(String),
        errorType: "retriable_exhausted",
        attempts: 2,
      },
    });
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("dead-letters a retriable failure at once when retries are off", async () => {
    reset("flaky", 5);
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { processes: { retry: { strategy: "none" } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    expect(calls).toEqual(["paid:o-1"]);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { errorType: "retriable_exhausted", attempts: 1 },
    ]);
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("claims each handler run with a lease of twice the handler timeout", async () => {
    reset("ok");
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { policies: { timeout: "10s" } } },
    });
    const leases: number[] = [];
    const original = harness.storage.inboxLedger.tryClaim.bind(harness.storage.inboxLedger);
    harness.storage.inboxLedger.tryClaim = async (args) => {
      leases.push(args.leaseMs);
      return original(args);
    };
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    expect(leases).toEqual([20_000]);
  });

  it("holds an event another instance claimed and handles it once that instance's lease expires", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    const paid = await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.storage.inboxLedger.tryClaim({
      subscriber: "order.orderPayment",
      eventId: paid.scheduled ? "" : (paid.eventIds[0] ?? ""),
      now: harness.clock.now(),
      leaseMs: 60_000,
    });

    await harness.dispatcher.processUntilIdle();
    expect(calls).toEqual([]);
    expect(await harness.storage.checkpointStore.get("processes")).toBeLessThan(
      await harness.storage.eventStore.lastPosition(),
    );

    harness.clock.advance(60_001);
    await harness.dispatcher.processUntilIdle();
    expect(calls).toEqual(["paid:o-1"]);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
  });

  it("holds and redelivers when another instance moved the process stream first", async () => {
    reset("ok");
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({ registry, logger });
    const original = harness.storage.eventStore.append.bind(harness.storage.eventStore);
    let interfered = false;
    harness.storage.eventStore.append = async (args) => {
      if (!interfered && args.aggregateType === "process:OrderPayment") {
        interfered = true;
        await original({
          ...args,
          events: args.events.map((event) => ({ ...event, id: "sneaky" })),
        });
      }
      return original(args);
    };
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processOnce();
    expect(await harness.storage.checkpointStore.get("processes")).toBe(0);
    expect(entries).toEqual([
      {
        level: "debug",
        message: "process stream moved; will redeliver",
        fields: { process: "order.orderPayment", eventId: expect.any(String) },
      },
    ]);

    await harness.dispatcher.processUntilIdle();
    expect(await harness.storage.checkpointStore.get("processes")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
    expect((await processStream(harness)).events.map((event) => event.id)).toEqual(["sneaky"]);
  });

  it("lets storage failures reach the dispatcher", async () => {
    reset("ok");
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({ registry, logger });
    const original = harness.storage.eventStore.load.bind(harness.storage.eventStore);
    harness.storage.eventStore.load = async (args) => {
      if (args.aggregateType.startsWith("process:")) throw new Error("db down");
      return original(args);
    };
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processOnce();
    expect(await harness.storage.checkpointStore.get("processes")).toBe(0);
    expect(entries).toEqual([
      {
        level: "error",
        message: "subscriber failed; batch will be redelivered",
        fields: {
          subscriber: "processes",
          afterPosition: 0,
          failedPosition: 1,
          message: "db down",
          stack: expect.any(String),
        },
      },
    ]);
  });

  it("ignores deadlines for unknown processes and for instances that are not running", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    const context = { correlationId: "c", causationId: "c", depth: 0 };
    await expect(
      harness.processes.handleDeadline({
        payload: { process: "order.nope", aggregateId: "o-1" },
        context,
      }),
    ).resolves.toBeUndefined();
    await harness.processes.handleDeadline({
      payload: { process: "order.orderPayment", aggregateId: "never" },
      context,
    });
    expect((await processStream(harness, "never")).events).toEqual([]);

    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(172_800_000);
    await harness.processes.handleDeadline({
      payload: { process: "order.orderPayment", aggregateId: "o-1" },
      context,
    });
    expect((await processStream(harness)).events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(calls).toEqual(["paid:o-1"]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });
});

describe("process collaborators", () => {
  const recorded: string[] = [];
  const audit = (tag: string) => ({
    record: (entry: string) => {
      recorded.push(`${tag}:${entry}`);
    },
  });
  const keys: string[] = [];
  interface AuditArgs {
    readonly aggregateId: string;
    readonly audit: { record: (entry: string) => void };
    readonly idempotencyKey: string;
  }
  const withAudit: Registry = {
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        processes: {
          orderPayment: {
            module: { config: () => ({ startedBy: ["order.OrderPlaced"], timeout: "1h" }) },
            handlers: {
              order: {
                orderPlaced: {
                  handler: ({ aggregateId, audit, idempotencyKey }: AuditArgs) => {
                    audit.record(`placed ${aggregateId}`);
                    keys.push(idempotencyKey);
                  },
                },
              },
            },
            deadlines: {
              timeout: {
                handler: ({ aggregateId, audit, idempotencyKey }: AuditArgs) => {
                  audit.record(`timed out ${aggregateId}`);
                  keys.push(idempotencyKey);
                },
              },
            },
            collaborators: { audit: { log: audit("log"), memory: audit("memory") } },
          },
        },
      },
    },
    readModels: {},
  };

  it("hands the configured implementation to event and timeout handlers", async () => {
    recorded.length = 0;
    const harness = await createReactiveHarness({
      registry: withAudit,
      config: { processes: { order: { orderPayment: { audit: { use: "memory" } } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(3_600_000);
    await harness.worker.runOnce();
    expect(recorded).toEqual(["memory:placed o-1", "memory:timed out o-1"]);
  });

  it("gives event handlers a key per event and the timeout one per instance and moment", async () => {
    keys.length = 0;
    const harness = await createReactiveHarness({
      registry: withAudit,
      config: { processes: { order: { orderPayment: { audit: { use: "memory" } } } } },
    });
    const placed = await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
    });
    await harness.dispatcher.processUntilIdle();
    const timeoutAt = new Date(harness.clock.now().getTime() + 3_600_000).toISOString();
    harness.clock.advance(3_600_000);
    await harness.worker.runOnce();
    expect(keys).toEqual([
      deriveIdempotencyKey({
        kind: "process",
        handler: "order.orderPayment",
        subject: placed.scheduled ? "" : (placed.eventIds[0] ?? ""),
      }),
      deriveIdempotencyKey({
        kind: "process",
        handler: "order.orderPayment",
        subject: `o-1:deadline:timeout:${timeoutAt}`,
      }),
    ]);
  });

  it("names the process and where to choose when several implementations exist", () => {
    expect(() =>
      buildProcesses({ registry: withAudit, config: resolveConfig({ storage: memory() }) }),
    ).toThrow(
      'Process "order.orderPayment", collaborator "audit": choose an implementation with processes.order.orderPayment.audit.use. Available: "log", "memory"',
    );
  });
});

describe("processes that listen to other aggregates", () => {
  const seen: string[] = [];
  interface PaymentArgs {
    readonly event: { aggregateId: string; payload: { orderId: string; reason?: string } };
    readonly state: { failures: number };
    readonly aggregateId: string;
  }
  interface PaymentEvents {
    readonly order: {
      readonly OrderPlaced: "order.OrderPlaced";
      readonly OrderPaid: "order.OrderPaid";
    };
    readonly payment: {
      readonly PaymentFailed: "payment.PaymentFailed";
      readonly PaymentSettled: "payment.PaymentSettled";
    };
  }
  const paymentPayload = ({ z }: PayloadArgs) =>
    z.object({ orderId: z.string(), reason: z.string().optional() });
  const paymentCommand = ({ z }: PayloadArgs) =>
    z.object({ paymentId: z.string(), orderId: z.string(), reason: z.string().optional() });
  const payment: Registry["aggregates"][string] = {
    events: {
      paymentFailed: { payload: paymentPayload, apply: () => ({}) },
      paymentSettled: { payload: paymentPayload, apply: () => ({}) },
    },
    commands: {
      failPayment: {
        module: {
          payload: paymentCommand,
          handler: ({
            command,
            events,
          }: {
            command: { payload: { orderId: string; reason?: string } };
            events: Record<string, (payload: unknown) => unknown>;
          }) => [
            events.paymentFailed?.({
              orderId: command.payload.orderId,
              reason: command.payload.reason,
            }),
          ],
        },
      },
      settlePayment: {
        module: {
          payload: paymentCommand,
          handler: ({
            command,
            events,
          }: {
            command: { payload: { orderId: string } };
            events: Record<string, (payload: unknown) => unknown>;
          }) => [events.paymentSettled?.({ orderId: command.payload.orderId })],
        },
      },
    },
    policies: {},
    processes: {},
  };
  const withCorrelate = (
    correlate: Record<
      string,
      Record<string, (event: { payload: { orderId: string } }) => string | null>
    >,
    returned: (state: { failures: number }) => unknown = (state) => ({
      failures: state.failures + 1,
    }),
  ): Registry => ({
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        processes: {
          checkout: {
            module: {
              config: ({ events }: { events: PaymentEvents }) => ({
                startedBy: [events.order.OrderPlaced],
                completedBy: [events.payment.PaymentSettled],
              }),
              state: ({ z }: PayloadArgs) => z.object({ failures: z.int().default(0) }),
              correlate,
            },
            handlers: {
              payment: {
                paymentFailed: {
                  handler: ({ event, state, aggregateId }: PaymentArgs) => {
                    seen.push(`${aggregateId} failed: ${event.payload.reason ?? ""}`);
                    return returned(state);
                  },
                },
              },
            },
          },
        },
      },
      payment,
    },
    readModels: {},
  });
  const byOrder = {
    payment: {
      PaymentFailed: (event: { payload: { orderId: string } }) => event.payload.orderId,
      PaymentSettled: (event: { payload: { orderId: string } }) => event.payload.orderId,
    },
  };
  const stream = (harness: Awaited<ReturnType<typeof createReactiveHarness>>, id: string) =>
    harness.storage.eventStore.load({ aggregateType: "process:Checkout", aggregateId: id });

  it("hand another aggregate's event to the instance correlate names, and complete on one", async () => {
    seen.length = 0;
    const harness = await createReactiveHarness({ registry: withCorrelate(byOrder) });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "FailPayment",
      payload: { paymentId: "p-1", orderId: "o-1", reason: "declined" },
    });
    await harness.pipeline.dispatch({
      type: "SettlePayment",
      payload: { paymentId: "p-2", orderId: "o-1" },
    });
    await harness.dispatcher.processUntilIdle();
    expect(seen).toEqual(["o-1 failed: declined"]);
    const events = (await stream(harness, "o-1")).events;
    expect(events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(events[1]?.payload).toMatchObject({
      state: { failures: 1 },
      eventType: "PaymentFailed",
    });
  });

  it("ignore an event correlate says belongs to no instance, or to one that never started", async () => {
    seen.length = 0;
    const harness = await createReactiveHarness({
      registry: withCorrelate({
        payment: {
          PaymentFailed: (event) =>
            event.payload.orderId === "ignored" ? null : event.payload.orderId,
          PaymentSettled: (event) => event.payload.orderId,
        },
      }),
    });
    await harness.pipeline.dispatch({
      type: "FailPayment",
      payload: { paymentId: "p-1", orderId: "ignored" },
    });
    await harness.pipeline.dispatch({
      type: "FailPayment",
      payload: { paymentId: "p-2", orderId: "o-never" },
    });
    await harness.dispatcher.processUntilIdle();
    expect(seen).toEqual([]);
    expect((await stream(harness, "o-never")).events).toEqual([]);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
  });

  it("refuse at boot another aggregate's event without correlate, or correlate for no event", () => {
    const config = resolveConfig({ storage: memory() });
    expect(() =>
      buildProcesses({
        registry: withCorrelate({ payment: { PaymentFailed: byOrder.payment.PaymentFailed } }),
        config,
      }),
    ).toThrow(
      'aggregates.order.processes.checkout: "payment.PaymentSettled" comes from another aggregate; say which instance it belongs to with correlate.payment.PaymentSettled',
    );
    expect(() =>
      buildProcesses({
        registry: withCorrelate({
          ...byOrder,
          billing: { Invoiced: (event) => event.payload.orderId },
        }),
        config,
      }),
    ).toThrow(
      'aggregates.order.processes.checkout.correlate.billing.Invoiced: "billing.Invoiced" is not an event of the app',
    );
  });

  it("treat a correlate entry left undefined as missing", () => {
    expect(() =>
      buildProcesses({
        registry: withCorrelate({
          payment: {
            PaymentFailed: byOrder.payment.PaymentFailed,
            PaymentSettled: undefined as never,
          },
        }),
        config: resolveConfig({ storage: memory() }),
      }),
    ).toThrow('"payment.PaymentSettled" comes from another aggregate');
  });

  it("start no instance for a starting event correlate says belongs to none", async () => {
    const registry = withCorrelate({
      payment: {
        PaymentFailed: () => null,
        PaymentSettled: (event) => event.payload.orderId,
      },
    });
    const checkout = registry.aggregates.order?.processes.checkout;
    const starting: Registry = {
      ...registry,
      aggregates: {
        ...registry.aggregates,
        order: {
          ...(registry.aggregates.order as Registry["aggregates"][string]),
          processes: {
            checkout: {
              ...(checkout as Registry["aggregates"][string]["processes"][string]),
              module: {
                ...(checkout?.module as Registry["aggregates"][string]["processes"][string]["module"]),
                config: ({ events }: { events: PaymentEvents }) => ({
                  startedBy: [events.payment.PaymentFailed],
                }),
              },
            },
          },
        },
      },
    };
    const harness = await createReactiveHarness({ registry: starting });
    await harness.pipeline.dispatch({
      type: "FailPayment",
      payload: { paymentId: "p-1", orderId: "o-1" },
    });
    await harness.dispatcher.processUntilIdle();
    expect((await stream(harness, "null")).events).toEqual([]);
    expect((await stream(harness, "o-1")).events).toEqual([]);
  });

  it("refuse to replay an event that belongs to no instance, or to one that is not there", async () => {
    const harness = await createReactiveHarness({
      registry: withCorrelate({
        payment: {
          PaymentFailed: (event) =>
            event.payload.orderId === "none" ? null : event.payload.orderId,
          PaymentSettled: (event) => event.payload.orderId,
        },
      }),
    });
    await harness.pipeline.dispatch({
      type: "FailPayment",
      payload: { paymentId: "p-1", orderId: "none" },
    });
    await harness.pipeline.dispatch({
      type: "FailPayment",
      payload: { paymentId: "p-2", orderId: "o-gone" },
    });
    const eventOf = async (paymentId: string) =>
      (await harness.storage.eventStore.load({ aggregateType: "payment", aggregateId: paymentId }))
        .events[0] as StoredEvent;
    for (const paymentId of ["p-1", "p-2"]) {
      await expect(
        harness.processes.replay({
          process: "order.checkout",
          event: await eventOf(paymentId),
          replay: "r",
        }),
      ).rejects.toThrow(`Process "order.checkout" has no instance for payment:${paymentId}`);
    }
  });

  it("dead-letter an event whose correlate throws or returns no id, and keep going", async () => {
    seen.length = 0;
    const harness = await createReactiveHarness({
      registry: withCorrelate({
        payment: {
          PaymentFailed: (event) => {
            if (event.payload.orderId === "boom") throw new Error("no order id on old events");
            if (event.payload.orderId === "empty") return "";
            return event.payload.orderId === "blank" ? (undefined as never) : event.payload.orderId;
          },
          PaymentSettled: (event) => event.payload.orderId,
        },
      }),
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    for (const [paymentId, orderId] of [
      ["p-1", "boom"],
      ["p-2", "blank"],
      ["p-4", "empty"],
      ["p-3", "o-1"],
    ] as const) {
      await harness.pipeline.dispatch({
        type: "FailPayment",
        payload: { paymentId, orderId, reason: paymentId },
      });
    }
    await harness.dispatcher.processUntilIdle();
    await harness.dispatcher.processUntilIdle();
    expect(seen).toEqual(["o-1 failed: p-3"]);
    const letters = await harness.storage.deadLetterStore.list();
    expect(
      letters.map((letter) => [letter.aggregateId, letter.errorType, letter.errorMessage]),
    ).toEqual([
      ["p-1", "terminal", "no order id on old events"],
      [
        "p-2",
        "terminal",
        expect.stringMatching(
          /^aggregates\.order\.processes\.checkout\.correlate returned undefined for payment\.PaymentFailed .+; expected the id of the order it belongs to, or null$/,
        ),
      ],
      [
        "p-4",
        "terminal",
        expect.stringMatching(/correlate returned "" for payment\.PaymentFailed /),
      ],
    ]);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
  });

  it("fail a handler for good when it returns a state its schema refuses", async () => {
    seen.length = 0;
    const harness = await createReactiveHarness({
      registry: withCorrelate(byOrder, () => ({ failures: "many" })),
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "FailPayment",
      payload: { paymentId: "p-1", orderId: "o-1", reason: "declined" },
    });
    await harness.dispatcher.processUntilIdle();
    expect((await stream(harness, "o-1")).events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
    ]);
    const [letter] = await harness.storage.deadLetterStore.list();
    expect(letter).toMatchObject({
      kind: "process",
      subscriber: "order.checkout",
      eventType: "PaymentFailed",
      aggregateType: "payment",
      aggregateId: "p-1",
      errorType: "terminal",
      errorMessage: "Process order.checkout returned a state its schema refuses",
    });
  });

  it("replay a dead-lettered handler of another aggregate's event on the instance correlate names", async () => {
    seen.length = 0;
    let broken = true;
    const harness = await createReactiveHarness({
      registry: withCorrelate(byOrder, (state) =>
        broken ? { failures: "many" } : { failures: state.failures + 1 },
      ),
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "FailPayment",
      payload: { paymentId: "p-1", orderId: "o-1", reason: "declined" },
    });
    await harness.dispatcher.processUntilIdle();
    const [letter] = await harness.storage.deadLetterStore.list();
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "payment",
      aggregateId: "p-1",
    });
    broken = false;
    await harness.processes.replay({
      process: letter?.subscriber ?? "",
      event: events[0] as (typeof events)[number],
      replay: "r-1",
    });
    expect((await stream(harness, "o-1")).events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
      PROCESS_EVENTS.handled,
    ]);
  });
});
