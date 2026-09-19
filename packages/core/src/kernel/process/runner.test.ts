import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../config/schema.ts";
import { DomainError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { ProcessConfigArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { orderAggregateEntry } from "../test-support.ts";
import { buildProcesses } from "./build-processes.ts";
import { PROCESS_EVENTS } from "./lifecycle.ts";

interface HandlerArgs {
  readonly event: { aggregateId: string; payload: { method?: string } };
  readonly state: { reminders: number; method: string | null };
  readonly aggregateId: string;
  readonly commands: Record<string, (payload: unknown) => Promise<unknown>>;
}

const calls: string[] = [];
let mode: "ok" | "domain" | "flaky" = "ok";
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
            }: ProcessConfigArgs<"OrderPlaced" | "OrderPaid" | "OrderArchived">) => ({
              startedBy: [events.OrderPlaced],
              completedBy: [events.OrderPaid, events.OrderArchived],
              timeout: "48h",
            }),
            state: ({ z }: PayloadArgs) =>
              z.object({
                reminders: z.int().default(0),
                method: z.string().nullable().default(null),
              }),
          },
          handlers: {
            orderPaid: {
              handler: ({ event, state }: HandlerArgs) => {
                calls.push(`paid:${event.aggregateId}`);
                if (mode === "domain") throw new DomainError("bad payment");
                if (mode === "flaky" && flakyFailures > 0) {
                  flakyFailures -= 1;
                  throw new Error("network");
                }
                return { ...state, method: event.payload.method ?? null };
              },
            },
          },
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
    expect([...(all[0]?.startedBy ?? [])]).toEqual(["OrderPlaced"]);
    expect(Object.keys(all[0]?.handlers ?? {})).toEqual(["OrderPaid"]);
    expect(Object.keys(byEvent).sort()).toEqual(["OrderArchived", "OrderPaid", "OrderPlaced"]);
  });

  it("falls back to the configured default timeout", () => {
    const withoutTimeout: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            quick: { module: { config: () => ({ startedBy: ["OrderPlaced"] }) }, handlers: {} },
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
  });

  it("rejects unknown events and state schemas without defaults", () => {
    const badEvent: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            p: { module: { config: () => ({ startedBy: ["OrderShipped"] }) }, handlers: {} },
          },
        },
      },
      readModels: {},
    };
    expect(() => buildProcesses({ registry: badEvent, config })).toThrow(
      'aggregates.order.processes.p: "OrderShipped" is not an event of this aggregate',
    );
    const badState: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            p: {
              module: {
                config: () => ({ startedBy: ["OrderPlaced"] }),
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
    expect((await harness.storage.scheduler.list()).map((entry) => entry.dedupeKey)).toEqual([
      "process-timeout:order.orderPayment:o-1",
    ]);

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
      "process-timeout:order.orderPayment:o-1",
    ]);
  });
});
