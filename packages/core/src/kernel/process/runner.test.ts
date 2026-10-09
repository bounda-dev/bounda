import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config/schema.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { ProcessCorrelation } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import {
  choosePorts,
  createRecordingLogger,
  type OrderProcessConfigArgs,
  orderAggregateEntry,
} from "../test-support.ts";
import { buildProcesses } from "./build-processes.ts";
import { PROCESS_DEADLINE_COMMAND } from "./deadlines.ts";
import { PROCESS_EVENTS } from "./lifecycle.ts";

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
                  if (mode === "domain") throw new ValidationError("bad payment", []);
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
  harness.storage.eventStore.load({ aggregateType: "process:order.orderPayment", aggregateId: id });

const processesOf = (registry: Registry, config: ResolvedConfig) =>
  buildProcesses({
    registry,
    aggregates: buildAggregates({ registry, ports: choosePorts(registry, config) }),
    config,
  });

describe("buildProcesses", () => {
  const config = resolveConfig({
    storage: memory(),
    ports: { order: { notifier: "memory" } },
  });

  it("compiles config, state defaults, handlers and timeout", () => {
    const { all, byEvent } = processesOf(registry, config);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      name: "order.orderPayment",
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
    const built = processesOf(
      withoutTimeout,
      resolveConfig({
        storage: memory(),
        ports: { order: { notifier: "memory" } },
        runtime: { processes: { timeout: "1h" } },
      }),
    );
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
    expect(() => processesOf(badStateShape, config)).toThrow(
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
    expect(() => processesOf(badHandler, config)).toThrow(
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
    expect(() => processesOf(badEvent, config)).toThrow(
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
    expect(() => processesOf(badState, config)).toThrow(/must accept an empty object/);
  });
});

describe("process runner", () => {
  it("starts on the starting event, handles, completes and cancels the timeout", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();

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
    await harness.dispatcher.runUntilIdle();
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
    await harness.dispatcher.runUntilIdle();
    expect((await processStream(harness, "o-2")).events).toEqual([]);

    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await harness.dispatcher.runUntilIdle();
    await harness.pipeline
      .dispatch({ type: "PayOrder", payload: { orderId: "o-1", method: "card" } })
      .catch(() => undefined);
    await harness.dispatcher.runUntilIdle();
    const stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.completed,
    ]);
    expect(calls).toEqual([]);

    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-3", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(48 * 3_600_000);
    await harness.worker.runOnce();
    await harness.dispatcher.runUntilIdle();
    expect((await processStream(harness, "o-3")).events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
    ]);
    const paidLate = async (orderId: string) => {
      const order = { aggregateType: "order", aggregateId: orderId };
      const { events } = await harness.storage.eventStore.load(order);
      const [placed] = events;
      if (placed === undefined) throw new Error("not placed");
      const id = `paid-late-${orderId}`;
      await harness.storage.eventStore.append({
        ...order,
        expectedVersion: events.length,
        events: [
          {
            ...placed,
            id,
            version: events.length + 1,
            type: "OrderPaid",
            payload: { method: "card" },
          },
        ],
      });
      return id;
    };
    const late = [await paidLate("o-1"), await paidLate("o-3")];
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["timeout:o-3"]);
    for (const eventId of late) {
      expect(
        await harness.storage.inboxLedger.get({ handler: "order.orderPayment", eventId }),
      ).toBeNull();
    }
    expect((await processStream(harness)).events).toHaveLength(2);
    expect((await processStream(harness, "o-3")).events).toHaveLength(2);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
  });

  it("runs the timeout handler when the schedule comes due and records the final state", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();

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

    await harness.dispatcher.runUntilIdle();
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
    await harness.dispatcher.runUntilIdle();

    const stream = await processStream(harness);
    expect(stream.events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
    ]);
    expect(stream.events[1]?.payload).toMatchObject({
      eventId: expect.any(String),
      error: "bad payment",
    });
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        kind: "process",
        handler: "order.orderPayment",
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
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["paid:o-1"]);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(1);

    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["paid:o-1"]);

    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();
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
    await harness.dispatcher.runUntilIdle();
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
      harness.storage.eventStore.load({
        aggregateType: "process:order.orderTotals",
        aggregateId: "o-1",
      });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
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
    await harness.dispatcher.runUntilIdle();
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
    await harness.dispatcher.runUntilIdle();
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
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["paid:o-1"]);
    expect(entries).toEqual([
      {
        level: "warn",
        message: "process handler failed; will retry",
        fields: { process: "order.orderPayment", eventId: expect.any(String), attempts: 1 },
      },
    ]);

    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();
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
    await harness.dispatcher.runUntilIdle();
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
    await harness.dispatcher.runUntilIdle();
    expect(leases).toEqual([20_000]);
  });

  it("holds an event another instance claimed and handles it once that instance's lease expires", async () => {
    reset("ok");
    const harness = await createReactiveHarness({ registry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    const paid = await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.storage.inboxLedger.tryClaim({
      handler: "order.orderPayment",
      eventId: "eventIds" in paid ? (paid.eventIds[0] ?? "") : "",
      now: harness.clock.now(),
      leaseMs: 60_000,
    });

    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual([]);
    expect(await harness.storage.checkpointStore.get("processes")).toBeLessThan(
      await harness.storage.eventStore.lastPosition(),
    );

    harness.clock.advance(60_001);
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["paid:o-1"]);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
  });

  it("holds and redelivers when another instance moved the process stream first", async () => {
    reset("ok");
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({
      registry,
      logger,
      config: { runtime: { commands: { concurrencyRetries: 0 } } },
    });
    const schedule = harness.storage.scheduler.schedule;
    let interfered = false;
    harness.storage.scheduler.schedule = async (args) => {
      if (!interfered) {
        interfered = true;
        const stream = { aggregateType: "process:order.orderPayment", aggregateId: "o-1" };
        await harness.storage.eventStore.append({
          ...stream,
          expectedVersion: 0,
          events: [
            {
              id: "sneaky",
              ...stream,
              version: 1,
              type: "ProcessStarted",
              payload: { state: { reminders: 0, method: null }, eventId: "elsewhere" },
              timestamp: "2026-01-01T00:00:00.000Z",
              metadata: {
                correlationId: "c",
                causationId: "c",
                depth: 0,
                schemaVersion: 1,
                system: true,
              },
            },
          ],
        });
      }
      return schedule(args);
    };
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processOnce();
    expect(interfered).toBe(true);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(0);
    expect(entries).toEqual([
      {
        level: "debug",
        message: "process stream moved; will redeliver",
        fields: { process: "order.orderPayment", eventId: expect.any(String) },
      },
    ]);

    await harness.dispatcher.runUntilIdle();
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
    await harness.dispatcher.runUntilIdle();
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

describe("process ports", () => {
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
          },
        },
        ports: {
          ...orderAggregateEntry().ports,
          audit: { log: { default: audit("log") }, memory: { default: audit("memory") } },
        },
      },
    },
    readModels: {},
  };

  it("hands the configured implementation to event and timeout handlers", async () => {
    recorded.length = 0;
    const harness = await createReactiveHarness({
      registry: withAudit,
      config: { ports: { order: { notifier: "memory", audit: "memory" } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(3_600_000);
    await harness.worker.runOnce();
    expect(recorded).toEqual(["memory:placed o-1", "memory:timed out o-1"]);
  });

  it("gives event handlers a key per event and the timeout one per instance and moment", async () => {
    keys.length = 0;
    const harness = await createReactiveHarness({
      registry: withAudit,
      config: { ports: { order: { notifier: "memory", audit: "memory" } } },
    });
    const placed = await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
    });
    await harness.dispatcher.runUntilIdle();
    const timeoutAt = new Date(harness.clock.now().getTime() + 3_600_000).toISOString();
    harness.clock.advance(3_600_000);
    await harness.worker.runOnce();
    expect(keys).toEqual([
      deriveIdempotencyKey({
        kind: "process",
        handler: "order.orderPayment",
        subject: "eventIds" in placed ? (placed.eventIds[0] ?? "") : "",
      }),
      deriveIdempotencyKey({
        kind: "process",
        handler: "order.orderPayment",
        subject: `o-1:deadline:timeout:${timeoutAt}`,
      }),
    ]);
  });

  it("names the aggregate and where to choose when several implementations exist", () => {
    expect(() =>
      choosePorts(
        withAudit,
        resolveConfig({ storage: memory(), ports: { order: { notifier: "memory" } } }),
      ),
    ).toThrow(
      'Aggregate "order", port "audit": choose an implementation with ports.order.audit. Available: "log", "memory"',
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
      paymentFailed: { payload: paymentPayload, evolve: () => ({}) },
      paymentSettled: { payload: paymentPayload, evolve: () => ({}) },
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
  type Correlators = Record<
    string,
    Record<string, (event: { payload: { orderId: string } }) => string | null>
  >;
  // The process's `correlate` for these correlators, one from.<aggregate>.<Event>(…) each.
  const correlateWith =
    (correlators: Correlators) =>
    ({
      from,
    }: {
      readonly from: Record<string, Record<string, (correlate: unknown) => unknown>>;
    }) =>
      Object.entries(correlators).flatMap(([source, byType]) =>
        Object.entries(byType).map(([type, correlator]) => from[source]?.[type]?.(correlator)),
      ) as ProcessCorrelation[];
  const withCorrelate = (
    correlators: Correlators | undefined,
    returned: (state: { failures: number }) => unknown = (state) => ({
      failures: state.failures + 1,
    }),
    paymentEntry: Registry["aggregates"][string] = payment,
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
              ...(correlators === undefined ? {} : { correlate: correlateWith(correlators) }),
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
      payment: paymentEntry,
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
    harness.storage.eventStore.load({ aggregateType: "process:order.checkout", aggregateId: id });

  it.each([
    ["the payload's id field", undefined],
    ["correlate", byOrder],
  ])(
    "hand another aggregate's event to the instance %s names, and complete on one",
    async (_, correlators) => {
      seen.length = 0;
      const harness = await createReactiveHarness({ registry: withCorrelate(correlators) });
      await harness.pipeline.dispatch({
        type: "PlaceOrder",
        payload: { orderId: "o-1", total: 10 },
      });
      await harness.pipeline.dispatch({
        type: "FailPayment",
        payload: { paymentId: "p-1", orderId: "o-1", reason: "declined" },
      });
      await harness.pipeline.dispatch({
        type: "SettlePayment",
        payload: { paymentId: "p-2", orderId: "o-1" },
      });
      await harness.dispatcher.runUntilIdle();
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
    },
  );

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
    await harness.dispatcher.runUntilIdle();
    expect(seen).toEqual([]);
    expect((await stream(harness, "o-never")).events).toEqual([]);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
  });

  it("refuse at boot another aggregate's event whose payload has no id field and that correlate leaves out", () => {
    const config = resolveConfig({
      storage: memory(),
      ports: { order: { notifier: "memory" } },
    });
    const byReference = ({ z }: PayloadArgs) => z.object({ reference: z.string() });
    const referenced = {
      ...payment,
      events: {
        paymentFailed: { payload: byReference, evolve: () => ({}) },
        paymentSettled: { payload: byReference, evolve: () => ({}) },
      },
    };
    expect(() =>
      processesOf(
        withCorrelate(
          { payment: { PaymentFailed: byOrder.payment.PaymentFailed } },
          undefined,
          referenced,
        ),
        config,
      ),
    ).toThrow(
      'aggregates.order.processes.checkout: "payment.PaymentSettled" comes from another aggregate; give its payload "orderId" or say which instance it belongs to with from.payment.PaymentSettled(…) in correlate',
    );
    expect(() => processesOf(withCorrelate(byOrder, undefined, referenced), config)).not.toThrow();
    const bare = {
      ...payment,
      events: {
        paymentFailed: { payload: paymentPayload, evolve: () => ({}) },
        paymentSettled: { evolve: () => ({}) },
      },
    };
    expect(() => processesOf(withCorrelate(undefined, undefined, bare), config)).toThrow(
      '"payment.PaymentSettled" comes from another aggregate; give its payload "orderId" or say which instance it belongs to with from.payment.PaymentSettled(…) in correlate',
    );
  });

  it("refuse at boot to read the id field through a payload schema that is not a plain object", () => {
    const config = resolveConfig({
      storage: memory(),
      ports: { order: { notifier: "memory" } },
    });
    const transformed = ({ z }: PayloadArgs) =>
      z.object({ orderId: z.string() }).transform((payload) => ({ ...payload, at: "now" }));
    const piped = {
      ...payment,
      events: {
        paymentFailed: { payload: paymentPayload, evolve: () => ({}) },
        paymentSettled: { payload: transformed, evolve: () => ({}) },
      },
    };
    expect(() => processesOf(withCorrelate(undefined, undefined, piped), config)).toThrow(
      'aggregates.order.processes.checkout: "payment.PaymentSettled" comes from another aggregate; its payload schema is not a plain z.object, so its "orderId" cannot be read; say which instance it belongs to with from.payment.PaymentSettled(…) in correlate',
    );
    expect(() =>
      processesOf(
        withCorrelate(
          { payment: { PaymentSettled: byOrder.payment.PaymentSettled } },
          undefined,
          piped,
        ),
        config,
      ),
    ).not.toThrow();
  });

  it("refuse at boot a correlate that is not a function, returns no list, names no event or names one twice", () => {
    const config = resolveConfig({
      storage: memory(),
      ports: { order: { notifier: "memory" } },
    });
    const withModule = (correlate: unknown): Registry => {
      const registry = withCorrelate(undefined);
      const order = registry.aggregates.order as Registry["aggregates"][string];
      const checkout = order.processes
        .checkout as Registry["aggregates"][string]["processes"][string];
      return {
        ...registry,
        aggregates: {
          ...registry.aggregates,
          order: {
            ...order,
            processes: {
              checkout: {
                ...checkout,
                module: { ...checkout.module, correlate: correlate as never },
              },
            },
          },
        },
      };
    };
    expect(() => processesOf(withModule(byOrder), config)).toThrow(
      "aggregates.order.processes.checkout: correlate must be a function of { from } returning from.<aggregate>.<Event>(…) for each event",
    );
    for (const returned of [
      byOrder,
      [null],
      [{ event: 1, correlate: byOrder.payment.PaymentFailed }],
      [{ event: "payment.PaymentFailed" }],
    ]) {
      expect(() =>
        processesOf(
          withModule(() => returned),
          config,
        ),
      ).toThrow(
        "aggregates.order.processes.checkout.correlate: return a list of from.<aggregate>.<Event>(…), one for each event",
      );
    }
    expect(() =>
      processesOf(
        withModule(
          ({ from }: { from: Record<string, Record<string, (correlate: unknown) => unknown>> }) => [
            from.payment?.PaymentFailed?.(byOrder.payment.PaymentFailed),
            { event: "payment.PaymentSettled" },
          ],
        ),
        config,
      ),
    ).toThrow("return a list of from.<aggregate>.<Event>(…), one for each event");
    const broken = new Error("no from here");
    expect(() =>
      processesOf(
        withModule(() => {
          throw broken;
        }),
        config,
      ),
    ).toThrow(expect.objectContaining({ cause: broken }));
    expect(() =>
      processesOf(
        withModule(({ from }: { from: Record<string, Record<string, () => unknown>> }) => [
          from.billing?.Invoiced?.(),
        ]),
        config,
      ),
    ).toThrow(
      "aggregates.order.processes.checkout.correlate: return a list of from.<aggregate>.<Event>(…), one for each event",
    );
    expect(() =>
      processesOf(
        withModule(({ from }: { from: Record<string, Record<string, () => unknown>> }) => [
          (from.billing as Record<string, () => unknown>).Invoiced?.(),
        ]),
        config,
      ),
    ).toThrow(/^aggregates\.order\.processes\.checkout\.correlate failed: /);
    expect(() =>
      processesOf(
        withCorrelate({ payment: { PaymentFailed: byOrder.payment.PaymentFailed } }),
        config,
      ),
    ).not.toThrow();
    expect(() =>
      processesOf(
        withModule(
          ({ from }: { from: Record<string, Record<string, (correlate: unknown) => unknown>> }) => [
            from.payment?.PaymentFailed?.(byOrder.payment.PaymentFailed),
            from.payment?.PaymentFailed?.(byOrder.payment.PaymentFailed),
          ],
        ),
        config,
      ),
    ).toThrow(
      'aggregates.order.processes.checkout.correlate: "payment.PaymentFailed" is correlated twice',
    );
  });

  it("dead-letter an event whose id field holds no id, and route an own event by its aggregateId", async () => {
    seen.length = 0;
    const numbered = ({ z }: PayloadArgs) =>
      z.object({ orderId: z.unknown(), reason: z.string().optional() });
    const harness = await createReactiveHarness({
      registry: withCorrelate(undefined, undefined, {
        ...payment,
        events: {
          paymentFailed: { payload: numbered, evolve: () => ({}) },
          paymentSettled: { payload: numbered, evolve: () => ({}) },
        },
        commands: {
          failPayment: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ paymentId: z.string() }),
              handler: ({ events }: { events: Record<string, (payload: unknown) => unknown> }) => [
                events.paymentFailed?.({ orderId: 42 }),
                events.paymentFailed?.({ orderId: "" }),
              ],
            },
          },
        },
      }),
      config: { runtime: { processes: { retry: { strategy: "none" } } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "FailPayment", payload: { paymentId: "p-1" } });
    await harness.dispatcher.runUntilIdle();

    expect(seen).toEqual([]);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { errorMessage: expect.stringMatching(/correlate returned 42 for payment\.PaymentFailed /) },
    ]);
    expect((await stream(harness, "o-1")).events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
    ]);
  });

  it("ignore an event whose id field is null", async () => {
    seen.length = 0;
    const optional = ({ z }: PayloadArgs) =>
      z.object({ orderId: z.string().nullable(), reason: z.string().optional() });
    const harness = await createReactiveHarness({
      registry: withCorrelate(undefined, undefined, {
        ...payment,
        events: {
          paymentFailed: { payload: optional, evolve: () => ({}) },
          paymentSettled: { payload: optional, evolve: () => ({}) },
        },
        commands: {
          failPayment: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ paymentId: z.string() }),
              handler: ({ events }: { events: Record<string, (payload: unknown) => unknown> }) => [
                events.paymentFailed?.({ orderId: null }),
              ],
            },
          },
        },
      }),
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "FailPayment", payload: { paymentId: "p-1" } });
    await harness.dispatcher.runUntilIdle();

    expect(seen).toEqual([]);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
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
    await harness.dispatcher.runUntilIdle();
    expect((await stream(harness, "null")).events).toEqual([]);
    expect((await stream(harness, "o-1")).events).toEqual([]);
  });

  it("refuse to retry an event that belongs to no instance, or to one that is not there", async () => {
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
        harness.processes.retry({
          process: "order.checkout",
          event: await eventOf(paymentId),
          retryId: "r",
        }),
      ).rejects.toThrow(`Process "order.checkout" has no instance for payment:${paymentId}`);
    }
  });

  it("dead-letter an event whose correlate throws or returns no id, and keep going", async () => {
    seen.length = 0;
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({
      logger,
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
    const [boom] = (
      await harness.storage.eventStore.load({ aggregateType: "payment", aggregateId: "p-1" })
    ).events;
    const key = { handler: "order.checkout", eventId: boom?.id ?? "" };
    await harness.storage.inboxLedger.tryClaim({
      ...key,
      now: harness.clock.now(),
      leaseMs: 60_000,
    });
    await harness.dispatcher.processOnce();
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    harness.clock.advance(60_001);
    await harness.dispatcher.runUntilIdle();
    await harness.dispatcher.runUntilIdle();
    expect(seen).toEqual(["o-1 failed: p-3"]);
    expect(await harness.storage.inboxLedger.get(key)).toMatchObject({ status: "succeeded" });
    expect(entries.filter((entry) => entry.message === "process dead-lettered")).toHaveLength(3);
    const filed = await harness.storage.deadLetterStore.count();
    await harness.storage.checkpointStore.set("processes", 0);
    await harness.dispatcher.runUntilIdle();
    expect(await harness.storage.deadLetterStore.count()).toBe(filed);
    expect(await harness.storage.checkpointStore.get("processes")).toBe(
      await harness.storage.eventStore.lastPosition(),
    );
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
    await harness.dispatcher.runUntilIdle();
    expect((await stream(harness, "o-1")).events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
    ]);
    const [letter] = await harness.storage.deadLetterStore.list();
    expect(letter).toMatchObject({
      kind: "process",
      handler: "order.checkout",
      eventType: "PaymentFailed",
      aggregateType: "payment",
      aggregateId: "p-1",
      errorType: "terminal",
      errorMessage: "Process order.checkout returned a state its schema refuses",
    });
  });

  it("retry a dead-lettered handler of another aggregate's event on the instance correlate names", async () => {
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
    await harness.dispatcher.runUntilIdle();
    await harness.pipeline.dispatch({
      type: "FailPayment",
      payload: { paymentId: "p-2", orderId: "o-1", reason: "declined" },
    });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await harness.storage.deadLetterStore.list();
    if (letter === undefined) throw new Error("no letter");
    expect(await harness.processes.parkedBehind(letter)).toBe(1);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "payment",
      aggregateId: "p-1",
    });
    broken = false;
    await harness.processes.retry({
      process: letter.handler,
      event: events[0] as (typeof events)[number],
      retryId: "r-1",
    });
    expect((await stream(harness, "o-1")).events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
      PROCESS_EVENTS.eventParked,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.resumed,
    ]);
  });
});
