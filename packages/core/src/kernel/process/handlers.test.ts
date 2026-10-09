import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "../../contracts/errors.ts";
import type { ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { createReactiveHarness, type ReactiveHarness } from "../reactive-harness.ts";
import { type OrderProcessConfigArgs, orderAggregateEntry } from "../test-support.ts";
import { validState } from "./handlers.ts";

const refused = (run: () => unknown): ValidationError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("expected a ValidationError");
};

describe("validState", () => {
  it("takes the state as it is when the process has no schema", () => {
    const state = { anything: true };

    expect(validState({ name: "order.orderPayment", stateSchema: null }, state)).toBe(state);
  });

  it("refuses a state that is not an object when the process has no schema", () => {
    const error = refused(() =>
      validState({ name: "order.orderPayment", stateSchema: null }, null),
    );

    expect(error.message).toBe("Process order.orderPayment returned a state that is not an object");
    expect(error.issues).toEqual([
      { path: [], message: "Return the fields that change, or nothing" },
    ]);
  });

  it("returns the state its schema parses", () => {
    const stateSchema = z.object({ attempts: z.number().default(0) });

    expect(validState({ name: "order.orderPayment", stateSchema }, {})).toEqual({ attempts: 0 });
  });

  it("refuses a state its schema refuses, with every issue by path and message", () => {
    const stateSchema = z.object({
      attempts: z.number(),
      items: z.array(z.object({ sku: z.string() })),
    });

    const error = refused(() =>
      validState(
        { name: "order.orderPayment", stateSchema },
        { attempts: "two", items: [{ sku: 1 }] },
      ),
    );

    expect(error.message).toBe("Process order.orderPayment returned a state its schema refuses");
    expect(error.issues).toEqual([
      { path: ["attempts"], message: expect.any(String) },
      { path: ["items", 0, "sku"], message: expect.any(String) },
    ]);
  });

  it("leaves symbol segments out of an issue's path", () => {
    const stateSchema = z.object({}).superRefine((_, context) => {
      context.addIssue({ code: "custom", message: "refused", path: [Symbol("meta"), "items", 0] });
    });

    const error = refused(() => validState({ name: "order.orderPayment", stateSchema }, {}));

    expect(error.issues).toEqual([{ path: ["items", 0], message: "refused" }]);
  });
});

describe("a process handler run that fails", () => {
  interface RunArgs {
    readonly state: { readonly nudge: string | null };
    readonly aggregateId: string;
    readonly after: (delay: string) => string;
    readonly commands: Record<string, (payload: unknown, options?: object) => Promise<unknown>>;
    readonly signal: AbortSignal;
  }

  let placed: (args: RunArgs) => Promise<object | undefined> = async () => undefined;
  let nudged: (args: RunArgs) => Promise<object | undefined> = async () => undefined;

  const registry: Registry = {
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        processes: {
          follow: {
            module: {
              config: ({ events }: OrderProcessConfigArgs<"OrderPlaced">) => ({
                startedBy: [events.order.OrderPlaced],
                timeout: "30d",
              }),
              state: ({ z, deadline }: ProcessStateArgs) => z.object({ nudge: deadline() }),
            },
            handlers: {
              order: { orderPlaced: { handler: (args: RunArgs) => placed(args) } },
            },
            deadlines: { nudge: { handler: (args: RunArgs) => nudged(args) } },
          },
        },
      },
    },
    readModels: {},
  };

  const setUp = (config: object = {}) =>
    createReactiveHarness({
      registry,
      config: { runtime: { processes: { retry: { strategy: "none" } }, ...config } },
    });

  const scheduledCommands = async (harness: ReactiveHarness) =>
    (await harness.storage.scheduler.list())
      .map((entry) => entry.command.type)
      .filter((type) => !type.startsWith("bounda."));

  const place = async (harness: ReactiveHarness) => {
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
  };

  it("leaves none of its scheduled commands behind when the retry takes another path", async () => {
    let runs = 0;
    placed = async ({ aggregateId, commands }) => {
      runs += 1;
      if (runs === 1) {
        await commands.payOrder?.({ orderId: aggregateId, method: "card" }, { delay: "1h" });
        throw new Error("gateway down");
      }
      await commands.archiveOrder?.({ orderId: aggregateId }, { delay: "2h" });
      return undefined;
    };
    const harness = await setUp({
      processes: { retry: { strategy: "fixed", baseDelay: "1s" } },
    });

    await place(harness);
    expect(await scheduledCommands(harness)).toEqual([]);
    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();

    expect(runs).toBe(2);
    expect(await scheduledCommands(harness)).toEqual(["ArchiveOrder"]);
  });

  it("runs again on the new state when its commit conflicts, leaving nothing of the first run", async () => {
    let runs = 0;
    let harness: ReactiveHarness | undefined;
    placed = async ({ aggregateId, commands }) => {
      runs += 1;
      if (runs > 1) {
        await commands.archiveOrder?.({ orderId: aggregateId }, { delay: "2h" });
        return undefined;
      }
      await commands.payOrder?.({ orderId: aggregateId, method: "card" }, { delay: "1h" });
      const stream = { aggregateType: "process:order.follow", aggregateId };
      const { events } = (await harness?.storage.eventStore.load(stream)) ?? { events: [] };
      await harness?.storage.eventStore.append({
        ...stream,
        expectedVersion: events.length,
        events: [
          {
            id: "touch",
            ...stream,
            version: events.length + 1,
            type: "ProcessTouched",
            payload: {},
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
      return undefined;
    };
    harness = await setUp();

    await place(harness);

    expect(runs).toBe(2);
    expect(await scheduledCommands(harness)).toEqual(["ArchiveOrder"]);
  });

  it("writes nothing of a deadline whose outcome is refused", async () => {
    placed = async ({ after }) => ({ nudge: after("1h") });
    nudged = async ({ state, aggregateId, commands }) => {
      await commands.payOrder?.({ orderId: aggregateId, method: "card" }, { delay: "1h" });
      return state;
    };
    const harness = await setUp();
    await place(harness);

    harness.clock.advance(3_600_000);
    await harness.worker.runOnce();
    await harness.dispatcher.runUntilIdle();

    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { eventId: "deadline:nudge", errorType: "terminal" },
    ]);
    expect(await scheduledCommands(harness)).toEqual([]);
  });

  it("stops the commands of a handler that ran out of time, and aborts its signal", async () => {
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const late = Promise.withResolvers<unknown>();
    let signal: AbortSignal | undefined;
    placed = async (args) => {
      signal = args.signal;
      started.resolve();
      await resume.promise;
      late.resolve(
        await args.commands
          .archiveOrder?.({ orderId: args.aggregateId })
          .catch((error: unknown) => error),
      );
      return undefined;
    };
    const harness = await setUp({ policies: { timeout: "1m" } });

    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    const processing = harness.dispatcher.runUntilIdle();
    await started.promise;
    expect(signal?.aborted).toBe(false);
    harness.clock.advance(60_000);
    await processing;
    resume.resolve();

    expect(await late.promise).toMatchObject({
      code: "REACTION_ABANDONED",
      cause: {
        code: "HANDLER_TIMEOUT",
        message: "process order.follow did not finish within 60000ms",
      },
    });
    expect(signal?.aborted).toBe(true);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(order.events.map((event) => event.type)).toEqual(["OrderPlaced"]);
  });

  it("commits the commands its handler did not await, and goes on past a rejection", async () => {
    let again: unknown;
    placed = async ({ aggregateId, commands }) => {
      void commands.archiveOrder?.({ orderId: aggregateId });
      again = await commands.placeOrder?.({ orderId: aggregateId, total: 1 });
      return undefined;
    };
    const harness = await setUp();
    await place(harness);

    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(events.map((event) => event.type)).toEqual(["OrderPlaced", "OrderArchived"]);
    expect(again).toMatchObject({ rejected: "AlreadyPlaced", message: "Order already placed" });
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
  });

  it("fails a deadline when a command its handler did not await fails", async () => {
    placed = async (args) => ({ nudge: args.after("1h") });
    nudged = async ({ aggregateId, commands }) => {
      void commands.payOrder?.({ orderId: aggregateId, method: "cash" });
      return { nudge: null };
    };
    const harness = await setUp();
    await place(harness);

    harness.clock.advance(3_600_000);
    await harness.worker.runOnce();

    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        eventId: "deadline:nudge",
        errorType: "terminal",
        errorMessage: "Invalid payload for command PayOrder",
      },
    ]);
  });
});

describe("what a process handler returns", () => {
  interface State {
    readonly paymentId: string | null;
    readonly method: string | null;
    readonly nudge: string | null;
  }
  interface PaidArgs {
    readonly event: { readonly payload: { readonly method: string } };
    readonly after: (delay: string) => string;
  }

  let paid: (args: PaidArgs) => unknown = () => undefined;
  let nudged: () => unknown = () => undefined;

  const registry: Registry = {
    aggregates: {
      order: {
        ...orderAggregateEntry(),
        processes: {
          checkout: {
            module: {
              config: ({ events }: OrderProcessConfigArgs<"OrderPlaced">) => ({
                startedBy: [events.order.OrderPlaced],
              }),
              state: ({ z, deadline }: ProcessStateArgs) =>
                z.object({
                  paymentId: z.string().nullable().default(null),
                  method: z.string().nullable().default(null),
                  nudge: deadline(),
                }),
            },
            handlers: {
              order: {
                orderPlaced: { handler: () => ({ paymentId: "p-1" }) },
                orderPaid: { handler: (args: PaidArgs) => paid(args) },
              },
            },
            deadlines: { nudge: { handler: () => nudged() } },
          },
        },
      },
    },
    readModels: {},
  };

  const run = async (): Promise<ReactiveHarness> => {
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
    return harness;
  };

  const states = async (harness: ReactiveHarness) =>
    (
      await harness.storage.eventStore.load({
        aggregateType: "process:order.checkout",
        aggregateId: "o-1",
      })
    ).events.map((event) => (event.payload as { readonly state?: State }).state);

  it("is merged over the state, so the fields it leaves out keep their value", async () => {
    paid = ({ event }) => ({ method: event.payload.method });

    expect((await states(await run())).at(-1)).toEqual({
      paymentId: "p-1",
      method: "card",
      nudge: null,
    });
  });

  it("sets a field back to its default only when it says so, not when it is undefined", async () => {
    paid = () => ({ paymentId: null, method: undefined });

    expect((await states(await run())).at(-1)).toEqual({
      paymentId: null,
      method: null,
      nudge: null,
    });

    paid = () => ({ paymentId: undefined, method: "card" });

    expect((await states(await run())).at(-1)).toEqual({
      paymentId: "p-1",
      method: "card",
      nudge: null,
    });
  });

  it.each([
    ["null", null],
    ["a string", "card"],
    ["an array", [{ method: "card" }]],
  ])("fails the process when it is %s", async (_, returned) => {
    paid = () => returned;
    const harness = await run();

    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        eventType: "OrderPaid",
        errorType: "terminal",
        errorMessage: "Process order.checkout returned a state its schema refuses",
      },
    ]);
  });

  it("fails the process when a deadline handler returns null", async () => {
    paid = ({ after }) => ({ nudge: after("1h") });
    nudged = () => null;
    const harness = await run();

    harness.clock.advance(3_600_000);
    await harness.worker.runOnce();

    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        eventId: "deadline:nudge",
        errorType: "terminal",
        errorMessage: "Process order.checkout returned a state its schema refuses",
      },
    ]);
  });
});
