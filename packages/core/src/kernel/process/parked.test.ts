import { describe, expect, it } from "vitest";
import type { RetryConfig } from "../../config/types.ts";
import { ConcurrencyError, DomainError } from "../../contracts/errors.ts";
import type { Instant } from "../../contracts/instant.ts";
import type { ProcessAfterFunction, ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { createDeadLetters } from "../dead-letters/dead-letters.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import {
  createRecordingLogger,
  type OrderProcessConfigArgs,
  orderAggregateEntry,
} from "../test-support.ts";
import { PROCESS_EVENTS } from "./lifecycle.ts";

interface TallyState {
  readonly seen: readonly string[];
  readonly nudge: Instant | null;
}

interface TallyArgs {
  readonly state: TallyState;
  readonly event: { readonly id: string; readonly type: string };
  readonly after: ProcessAfterFunction;
}

const runs: string[] = [];
let failing = new Map<string, "terminal" | "retriable">();
const failingEvents = new Map<string, "terminal" | "retriable">();

const failIfAsked = (label: string): void => {
  const kind = failing.get(label);
  if (kind === "terminal") throw new DomainError(`${label} refuses`);
  if (kind === "retriable") throw new Error(`${label} is down`);
};

let whileHandling: (() => Promise<void>) | undefined;

const tally =
  (label: string) =>
  async ({ state, event }: TallyArgs): Promise<TallyState> => {
    runs.push(`${label}:${event.id}`);
    const during = whileHandling;
    whileHandling = undefined;
    await during?.();
    failIfAsked(label);
    if (failingEvents.get(event.id) === "terminal") throw new DomainError(`${event.id} refuses`);
    if (failingEvents.get(event.id) === "retriable") throw new Error(`${event.id} is down`);
    return { ...state, seen: [...state.seen, label] };
  };

const registry: Registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      processes: {
        tally: {
          module: {
            config: ({
              events,
            }: OrderProcessConfigArgs<"OrderPlaced" | "OrderPaid" | "OrderArchived">) => ({
              startedBy: [events.order.OrderPlaced],
              completedBy: [events.order.OrderArchived],
              timeout: "30d",
            }),
            state: ({ z, deadline }: ProcessStateArgs) =>
              z.object({ seen: z.array(z.string()).default([]), nudge: deadline() }),
          },
          handlers: {
            order: {
              orderPlaced: {
                handler: ({ state, after: later }: TallyArgs) => ({
                  ...state,
                  nudge: later("1d"),
                }),
              },
              orderPaid: { handler: tally("paid") },
            },
          },
          deadlines: {
            nudge: {
              handler: ({ state }: TallyArgs) => {
                runs.push("nudge");
                failIfAsked("nudge");
                return { ...state, nudge: null };
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
};

const DAY = 86_400_000;
const stream = { aggregateType: "process:Tally", aggregateId: "o-1" };

const reset = (): void => {
  runs.length = 0;
  failing = new Map();
  failingEvents.clear();
  whileHandling = undefined;
};

const setUp = async (retry: RetryConfig = { strategy: "none" }) => {
  reset();
  const { logger, entries: logs } = createRecordingLogger();
  const harness = await createReactiveHarness({
    registry,
    config: { runtime: { processes: { retry } } },
    logger,
  });
  const deadLetters = createDeadLetters({
    storage: harness.storage,
    pipeline: harness.pipeline,
    policies: harness.policies,
    policyExecutor: harness.policyExecutor,
    processes: harness.processes,
    ids: harness.ids,
    clock: harness.clock,
    logger: harness.logger,
  });
  const settle = async (): Promise<void> => {
    for (;;) {
      await harness.dispatcher.processUntilIdle();
      if ((await harness.worker.runOnce()) === 0) return;
    }
  };
  const types = async () =>
    (await harness.storage.eventStore.load(stream)).events.map((event) => event.type);
  const pay = () =>
    harness.pipeline.dispatch({ type: "PayOrder", payload: { orderId: "o-1", method: "card" } });
  return { harness, deadLetters, settle, types, pay, logs };
};

const failOnFirstPayment = async (context: Awaited<ReturnType<typeof setUp>>) => {
  const { harness, settle, pay } = context;
  await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
  await settle();
  failing.set("paid", "terminal");
  await pay();
  await settle();
  failing.delete("paid");
};

describe("events of a failed process", () => {
  it("are parked in its stream, in order, and nothing of the process runs meanwhile", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types, pay } = context;
    await failOnFirstPayment(context);
    await pay().catch(() => undefined);
    await harness.pipeline.dispatch({ type: "TouchOrder", payload: { orderId: "o-1" } });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    harness.clock.advance(2 * DAY);
    await settle();

    expect(await types()).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.failed,
      PROCESS_EVENTS.eventParked,
    ]);
    expect(runs).toEqual([expect.stringMatching(/^paid:/)]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({ eventType: "OrderPaid", parked: 1 });
    expect(await deadLetters.get(letter?.id ?? "")).toMatchObject({ parked: 1 });
  });

  it("run in order after the failure is replayed, before the process resumes and its deadlines with it", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types, logs } = context;
    await failOnFirstPayment(context);
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await settle();
    const [letter] = await deadLetters.list();

    const replayed = await deadLetters.replay(letter?.id ?? "");
    expect(replayed).toMatchObject({ status: "replayed", parked: 0 });
    expect(await types()).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.failed,
      PROCESS_EVENTS.eventParked,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(logs.map((entry) => entry.message)).not.toContain(
      "process no longer acts on an event it waited for; it is let through",
    );
  });

  it("resume the process once none is left, which schedules its deadlines again", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    harness.clock.advance(2 * DAY);
    await settle();
    expect(runs).toHaveLength(1);

    await deadLetters.replay((await deadLetters.list())[0]?.id ?? "");
    expect((await types()).slice(-2)).toEqual([PROCESS_EVENTS.handled, PROCESS_EVENTS.resumed]);
    await settle();
    expect(runs.at(-1)).toBe("nudge");
  });

  it("keep one that fails again as the new failure, with the rest still parked behind it", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [1, 2].map((offset) => ({
        ...paid,
        id: `again-${offset}`,
        version: order.events.length + offset,
      })),
    });
    await settle();
    const [first] = await deadLetters.list();
    expect(first).toMatchObject({ parked: 2 });

    failingEvents.set("again-1", "terminal");
    const replayed = await deadLetters.replay(first?.id ?? "");
    expect(replayed).toMatchObject({ status: "replayed", parked: 2 });
    const [second] = await deadLetters.list({ status: "failed" });
    expect(second).toMatchObject({ eventId: "again-1", parked: 1, errorType: "terminal" });
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);

    failingEvents.clear();
    await deadLetters.replay(second?.id ?? "");
    expect(runs.filter((run) => run.startsWith("paid:again"))).toEqual([
      "paid:again-1",
      "paid:again-1",
      "paid:again-2",
    ]);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
    expect(await deadLetters.list({ status: "failed" })).toEqual([]);
  });

  it("stay parked for good when the failure is discarded", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types, pay } = context;
    await failOnFirstPayment(context);
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await settle();
    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({ parked: 1 });
    expect((await deadLetters.discard(letter?.id ?? "")).status).toBe("discarded");
    await pay().catch(() => undefined);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const archived = order.events.at(-1);
    if (archived === undefined) throw new Error("not archived");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...archived, id: "after-discard", version: order.events.length + 1 }],
    });
    harness.clock.advance(40 * DAY);
    await settle();
    expect((await types()).filter((type) => type === PROCESS_EVENTS.eventParked)).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(await deadLetters.list({ status: "discarded" })).toMatchObject([{ parked: 0 }]);
    expect(await deadLetters.get("nope")).toBeNull();
  });

  it("wait behind a failed deadline, which runs first when replayed", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    failing.set("nudge", "terminal");
    harness.clock.advance(DAY);
    await settle();
    failing.delete("nudge");
    await context.pay();
    await settle();
    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({ eventId: "deadline:nudge", parked: 1 });

    await deadLetters.replay(letter?.id ?? "");
    expect(runs).toEqual(["nudge", "nudge", expect.stringMatching(/^paid:/)]);
    expect((await types()).slice(-3)).toEqual([
      PROCESS_EVENTS.deadlineReached,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.resumed,
    ]);
  });

  it("carry on from where a replay that broke off left them, without running its failure twice", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    await context.pay().catch(() => undefined);
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await settle();
    const [letter] = await deadLetters.list();

    const load = harness.storage.eventStore.load;
    let orderLoads = 0;
    harness.storage.eventStore.load = async (args) => {
      if (args.aggregateType === "order") {
        orderLoads += 1;
        if (orderLoads === 2) throw new Error("disk hiccup");
      }
      return load(args);
    };
    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow("disk hiccup");
    harness.storage.eventStore.load = load;
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(2);

    await deadLetters.replay(letter?.id ?? "");
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(2);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.completed);
  });

  it("include one parked while the failure is being replayed, before the process resumes", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnFirstPayment(context);
    const [letter] = await deadLetters.list();
    const append = harness.storage.eventStore.append;
    let arrived = false;
    harness.storage.eventStore.append = async (args) => {
      if (!arrived && args.events[0]?.type === PROCESS_EVENTS.resumed) {
        arrived = true;
        await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
        await harness.dispatcher.processUntilIdle();
      }
      return append(args);
    };
    await deadLetters.replay(letter?.id ?? "");
    harness.storage.eventStore.append = append;
    expect(arrived).toBe(true);
    expect((await types()).slice(-4)).toEqual([
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.eventParked,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
  });

  it("keep an event that was still retrying when a deadline failed the process", async () => {
    const context = await setUp({ strategy: "fixed", maxAttempts: 5, baseDelay: 60_000 });
    const { harness, deadLetters, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    failing.set("paid", "retriable");
    failing.set("nudge", "terminal");
    await context.pay();
    await harness.dispatcher.processUntilIdle();
    harness.clock.advance(DAY);
    for (let round = 0; round < 12; round += 1) await harness.worker.runOnce();
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);

    failing.delete("paid");
    harness.clock.advance(60_000);
    await harness.dispatcher.processUntilIdle();
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.eventParked);
    expect((await deadLetters.list())[0]).toMatchObject({ eventId: "deadline:nudge", parked: 1 });
  });

  it("park only what would do something, and each event once", async () => {
    const context = await setUp();
    const { harness, settle, types } = context;
    await failOnFirstPayment(context);
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await settle();
    await harness.storage.checkpointStore.set("processes", 0);
    await settle();
    expect((await types()).filter((type) => type === PROCESS_EVENTS.eventParked)).toHaveLength(1);
  });

  it("refuse to resume on a parked event that is gone", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await failOnFirstPayment(context);
    const { events } = await harness.storage.eventStore.load(stream);
    await harness.storage.eventStore.append({
      ...stream,
      expectedVersion: events.length,
      events: [
        {
          ...(events.at(-1) as (typeof events)[number]),
          id: "ghost-parking",
          version: events.length + 1,
          type: PROCESS_EVENTS.eventParked,
          payload: {
            eventId: "ghost",
            eventType: "OrderArchived",
            aggregateType: "order",
            aggregateId: "o-1",
          },
        },
      ],
    });
    const [letter] = await deadLetters.list();
    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow(
      "Parked event ghost of order:o-1 not found",
    );
  });

  it("dead-letter a parked event that fails for a transient reason as having run out of attempts", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...paid, id: "flaky", version: order.events.length + 1 }],
    });
    await settle();
    failingEvents.set("flaky", "retriable");
    await deadLetters.replay((await deadLetters.list())[0]?.id ?? "");
    expect(await deadLetters.list({ status: "failed" })).toMatchObject([
      { eventId: "flaky", errorType: "retriable_exhausted", errorMessage: "flaky is down" },
    ]);
  });

  it("write a parked event's outcome again, without running it twice, when a park got there first", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...paid, id: "late-payment", version: order.events.length + 1 }],
    });
    await harness.dispatcher.processUntilIdle();
    const append = harness.storage.eventStore.append;
    let raced = false;
    harness.storage.eventStore.append = async (args) => {
      const [first] = args.events;
      if (
        !raced &&
        first?.type === PROCESS_EVENTS.handled &&
        (first.payload as { eventId?: string }).eventId === "late-payment"
      ) {
        raced = true;
        await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
        await harness.dispatcher.processUntilIdle();
      }
      return append(args);
    };
    await deadLetters.replay((await deadLetters.list())[0]?.id ?? "");
    harness.storage.eventStore.append = append;
    expect(raced).toBe(true);
    expect(runs.filter((run) => run === "paid:late-payment")).toHaveLength(1);
    expect((await types()).slice(-4)).toEqual([
      PROCESS_EVENTS.eventParked,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(await deadLetters.list({ status: "failed" })).toEqual([]);
  });

  it("let a failure to resume reach the caller, and resume on the next replay", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnFirstPayment(context);
    const append = harness.storage.eventStore.append;
    let broken = true;
    harness.storage.eventStore.append = async (args) => {
      if (broken && args.events[0]?.type === PROCESS_EVENTS.resumed) {
        broken = false;
        throw new Error("disk full");
      }
      return append(args);
    };
    const [letter] = await deadLetters.list();
    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow("disk full");
    harness.storage.eventStore.append = append;
    await deadLetters.replay(letter?.id ?? "");
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(2);
  });

  it("handle an event parked on a handler-less trigger of the process only if it would act", async () => {
    const quiet: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            quiet: {
              module: {
                config: ({ events }: OrderProcessConfigArgs<"OrderPlaced" | "OrderArchived">) => ({
                  startedBy: [events.order.OrderPlaced, events.order.OrderArchived],
                }),
              },
              handlers: {
                order: {
                  orderPlaced: {
                    handler: () => {
                      throw new DomainError("no");
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
    const harness = await createReactiveHarness({ registry: quiet });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await harness.dispatcher.processUntilIdle();
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "process:Quiet",
      aggregateId: "o-1",
    });
    expect(events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
    ]);
  });

  it("let a parked event through when the process no longer acts on it", async () => {
    const context = await setUp();
    const letThrough = createRecordingLogger();
    const { harness, settle } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const [placed] = order.events;
    if (placed === undefined) throw new Error("not placed");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...placed, id: "placed-again", version: order.events.length + 1 }],
    });
    await settle();
    expect((await harness.storage.eventStore.load(stream)).events.at(-1)?.type).toBe(
      PROCESS_EVENTS.eventParked,
    );

    const tallyEntry = registry.aggregates.order?.processes.tally;
    if (tallyEntry === undefined) throw new Error("no process");
    const deployed = await createReactiveHarness({
      registry: {
        aggregates: {
          order: {
            ...orderAggregateEntry(),
            processes: {
              tally: {
                ...tallyEntry,
                handlers: { order: { orderPaid: { handler: tally("paid") } } },
              },
            },
          },
        },
        readModels: {},
      },
      logger: letThrough.logger,
    });
    for (const aggregateType of ["order", stream.aggregateType]) {
      const { events } = await harness.storage.eventStore.load({
        aggregateType,
        aggregateId: "o-1",
      });
      await deployed.storage.eventStore.append({
        aggregateType,
        aggregateId: "o-1",
        expectedVersion: 0,
        events,
      });
    }
    const failure = (
      await deployed.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events.find((event) => event.type === "OrderPaid");
    if (failure === undefined) throw new Error("no payment");
    await deployed.processes.replay({ process: "order.tally", event: failure, replay: "r" });
    const { events } = await deployed.storage.eventStore.load(stream);
    expect(events.slice(-3).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.resumed,
    ]);
    expect(events.at(-2)?.payload).toMatchObject({ eventId: "placed-again" });
    expect(letThrough.entries).toContainEqual({
      level: "warn",
      message: "process no longer acts on an event it waited for; it is let through",
      fields: { process: "order.tally", aggregateId: "o-1", eventId: "placed-again" },
    });
  });

  it("refuse to replay a letter of an instance that is failed on another step", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await context.settle();
    failing.set("nudge", "terminal");
    harness.clock.advance(DAY);
    await context.settle();
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    await expect(
      harness.processes.replay({
        process: "order.tally",
        event: order.events[0] as NonNullable<(typeof order.events)[number]>,
        replay: "r",
      }),
    ).rejects.toThrow(
      'Process "order.tally" is failed on another step for o-1; replay the dead letter of that failure first',
    );
    expect(await deadLetters.list()).toMatchObject([{ eventId: "deadline:nudge" }]);
  });

  it("say a replay failed again even when the only parked event is the one that failed", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...paid, id: "only", version: order.events.length + 1 }],
    });
    await settle();
    failingEvents.set("only", "terminal");
    const replayed = await deadLetters.replay((await deadLetters.list())[0]?.id ?? "");
    expect(replayed).toMatchObject({ status: "replayed", parked: 1 });
    expect(await deadLetters.list({ status: "failed" })).toMatchObject([
      { eventId: "only", parked: 0 },
    ]);
  });

  it("finish a replay during which an event was parked, running the failed handler once", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnFirstPayment(context);
    whileHandling = async () => {
      await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
      await harness.dispatcher.processUntilIdle();
    };
    await deadLetters.replay((await deadLetters.list())[0]?.id ?? "");
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(2);
    expect((await types()).slice(-4)).toEqual([
      PROCESS_EVENTS.eventParked,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
  });

  it("run a deadline that came due while failed before the parked events that arrived after it", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    harness.clock.advance(2 * DAY);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [
        {
          ...paid,
          id: "later",
          version: order.events.length + 1,
          timestamp: harness.clock.now().toISOString(),
        },
      ],
    });
    await settle();
    await deadLetters.replay((await deadLetters.list())[0]?.id ?? "");
    expect(runs.slice(1)).toEqual([expect.stringMatching(/^paid:/), "nudge", "paid:later"]);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
  });

  it("recover a replay that broke off while recording that a parked event failed", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...paid, id: "stubborn", version: order.events.length + 1 }],
    });
    await settle();
    const [first] = await deadLetters.list();
    failingEvents.set("stubborn", "terminal");
    const append = harness.storage.eventStore.append;
    let crashed = false;
    harness.storage.eventStore.append = async (args) => {
      if (!crashed && args.events[0]?.type === PROCESS_EVENTS.failed) {
        crashed = true;
        throw new Error("crash");
      }
      return append(args);
    };
    await expect(deadLetters.replay(first?.id ?? "")).rejects.toThrow("crash");
    harness.storage.eventStore.append = append;
    await deadLetters.replay(first?.id ?? "");
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);
    const failed = await deadLetters.list({ status: "failed" });
    expect(failed.map((letter) => letter.eventId)).toEqual(["stubborn"]);
    failingEvents.clear();
    await deadLetters.replay(failed[0]?.id ?? "");
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
  });

  it("let a failure through when a deploy removed its handler, and resume", async () => {
    const context = await setUp();
    const letThrough = createRecordingLogger();
    const { harness } = context;
    await failOnFirstPayment(context);
    const tallyEntry = registry.aggregates.order?.processes.tally;
    if (tallyEntry === undefined) throw new Error("no process");
    const deployed = await createReactiveHarness({
      registry: {
        aggregates: {
          order: {
            ...orderAggregateEntry(),
            processes: { tally: { ...tallyEntry, handlers: {} } },
          },
        },
        readModels: {},
      },
      logger: letThrough.logger,
    });
    for (const aggregateType of ["order", stream.aggregateType]) {
      const { events } = await harness.storage.eventStore.load({
        aggregateType,
        aggregateId: "o-1",
      });
      await deployed.storage.eventStore.append({
        aggregateType,
        aggregateId: "o-1",
        expectedVersion: 0,
        events,
      });
    }
    const failure = (
      await deployed.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events.find((event) => event.type === "OrderPaid");
    if (failure === undefined) throw new Error("no payment");
    await deployed.processes.replay({ process: "order.tally", event: failure, replay: "r" });
    const { events } = await deployed.storage.eventStore.load(stream);
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.resumed,
    ]);
    expect(letThrough.entries).toContainEqual({
      level: "warn",
      message: "process no longer acts on an event it waited for; it is let through",
      fields: { process: "order.tally", aggregateId: "o-1", eventId: failure.id },
    });
  });

  it("fail on a deadline that fails while draining, with what came after it still parked", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    harness.clock.advance(2 * DAY);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [
        {
          ...paid,
          id: "after",
          version: order.events.length + 1,
          timestamp: harness.clock.now().toISOString(),
        },
      ],
    });
    await settle();
    failing.set("nudge", "retriable");
    const replayed = await deadLetters.replay((await deadLetters.list())[0]?.id ?? "");
    expect(replayed.parked).toBe(2);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);
    expect((await harness.storage.eventStore.load(stream)).events.at(-1)?.payload).toMatchObject({
      deadline: "nudge",
    });
    const [letter] = await deadLetters.list({ status: "failed" });
    expect(letter).toMatchObject({
      eventId: "deadline:nudge",
      errorType: "retriable_exhausted",
      parked: 1,
    });

    failing.delete("nudge");
    await deadLetters.replay(letter?.id ?? "");
    expect(runs.slice(-2)).toEqual(["nudge", "paid:after"]);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
  });

  it("give up a write when something other than a park reached the instance meanwhile", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await failOnFirstPayment(context);
    whileHandling = async () => {
      const { events } = await harness.storage.eventStore.load(stream);
      await harness.storage.eventStore.append({
        ...stream,
        expectedVersion: events.length,
        events: [
          {
            ...(events.at(-1) as (typeof events)[number]),
            id: "operator",
            version: events.length + 1,
            type: PROCESS_EVENTS.completed,
            payload: {},
          },
        ],
      });
    };
    await expect(
      deadLetters.replay((await deadLetters.list())[0]?.id ?? ""),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("leave a parked event to the drain that handled it first", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...paid, id: "shared", version: order.events.length + 1 }],
    });
    await context.settle();
    const [letter] = await deadLetters.list();
    const handleOnce = async () => {
      whileHandling = async () => {
        const { events } = await harness.storage.eventStore.load(stream);
        await harness.storage.eventStore.append({
          ...stream,
          expectedVersion: events.length,
          events: [
            {
              ...(events.at(-1) as (typeof events)[number]),
              id: "other-drain",
              version: events.length + 1,
              type: PROCESS_EVENTS.handled,
              payload: { state: { seen: [], nudge: null }, eventId: "shared" },
            },
          ],
        });
        failingEvents.set("shared", "terminal");
      };
    };
    const append = harness.storage.eventStore.append;
    harness.storage.eventStore.append = async (args) => {
      const [first] = args.events;
      if (
        first?.type === PROCESS_EVENTS.handled &&
        (first.payload as { eventId?: string }).eventId !== "shared"
      ) {
        await handleOnce();
      }
      return append(args);
    };
    await deadLetters.replay(letter?.id ?? "");
    harness.storage.eventStore.append = append;
    expect(await deadLetters.list({ status: "failed" })).toEqual([]);
  });

  it("count nothing parked for a letter whose process is gone", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await harness.storage.deadLetterStore.add({
      id: "orphan-letter",
      kind: "process",
      subscriber: "order.gone",
      eventId: "deadline:x",
      eventType: "bounda.ProcessDeadline",
      aggregateType: "process:Gone",
      aggregateId: "o-1",
      errorType: "terminal",
      errorMessage: "x",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await deadLetters.get("orphan-letter")).toMatchObject({ parked: 0 });
  });

  const rawAppend = async (
    harness: Awaited<ReturnType<typeof setUp>>["harness"],
    type: string,
    payload: unknown,
  ): Promise<void> => {
    const { events } = await harness.storage.eventStore.load(stream);
    const last = events.at(-1);
    if (last === undefined) throw new Error("no instance");
    await harness.storage.eventStore.append({
      ...stream,
      expectedVersion: events.length,
      events: [{ ...last, id: `raw-${events.length}`, version: events.length + 1, type, payload }],
    });
  };

  it("file one letter when recording a failure lost a race and the event failed again", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    failing.set("paid", "terminal");
    const append = harness.storage.eventStore.append;
    let raced = false;
    harness.storage.eventStore.append = async (args) => {
      if (!raced && args.events[0]?.type === PROCESS_EVENTS.failed) {
        raced = true;
        await rawAppend(harness, PROCESS_EVENTS.handled, { state: { seen: [], nudge: null } });
      }
      return append(args);
    };
    await context.pay();
    await harness.dispatcher.processUntilIdle();
    harness.storage.eventStore.append = append;
    expect(raced).toBe(true);
    expect(await deadLetters.list()).toEqual([]);
    harness.clock.advance(harness.config.runtime.policies.timeoutMs * 2 + 1);
    await harness.dispatcher.processUntilIdle();
    expect((await deadLetters.list()).map((letter) => letter.eventType)).toEqual(["OrderPaid"]);
  });

  it("file no letter for a deadline whose process failed on something else meanwhile", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    failing.set("nudge", "terminal");
    const append = harness.storage.eventStore.append;
    let raced = false;
    harness.storage.eventStore.append = async (args) => {
      if (!raced && (args.events[0]?.payload as { deadline?: string })?.deadline === "nudge") {
        raced = true;
        await rawAppend(harness, PROCESS_EVENTS.failed, { eventId: "elsewhere", error: "x" });
      }
      return append(args);
    };
    harness.clock.advance(DAY);
    await settle();
    harness.storage.eventStore.append = append;
    expect(raced).toBe(true);
    expect((await deadLetters.list()).map((letter) => letter.eventId)).not.toContain(
      "deadline:nudge",
    );
  });

  it("file a letter again when writing it was cut short", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    const add = harness.storage.deadLetterStore.add;
    let cut = true;
    harness.storage.deadLetterStore.add = async (letter) => {
      if (cut) {
        cut = false;
        throw new Error("store down");
      }
      return add(letter);
    };
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    failing.set("paid", "terminal");
    await context.pay();
    await harness.dispatcher.processUntilIdle();
    expect(cut).toBe(false);
    expect(await deadLetters.list()).toMatchObject([
      { eventType: "OrderPaid", status: "failed", errorMessage: "paid refuses" },
    ]);
  });

  it("keep order when an event's park loses the race to the instance resuming", async () => {
    const context = await setUp();
    const { harness, types } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...paid, id: "first", version: order.events.length + 1 }],
    });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    const append = harness.storage.eventStore.append;
    let raced = false;
    harness.storage.eventStore.append = async (args) => {
      if (!raced && args.events[0]?.type === PROCESS_EVENTS.eventParked) {
        raced = true;
        await rawAppend(harness, PROCESS_EVENTS.resumed, {});
      }
      return append(args);
    };
    await harness.dispatcher.processUntilIdle();
    harness.storage.eventStore.append = append;
    expect(raced).toBe(true);
    const lifecycle = (await harness.storage.eventStore.load(stream)).events;
    expect(
      lifecycle
        .slice(-3)
        .map((event) => [event.type, (event.payload as { eventId?: string }).eventId]),
    ).toEqual([
      [PROCESS_EVENTS.resumed, undefined],
      [PROCESS_EVENTS.handled, "first"],
      [PROCESS_EVENTS.completed, expect.any(String)],
    ]);
    void types;
  });

  it("let a failed deadline through when a deploy removed its handler and kept the field", async () => {
    const context = await setUp();
    const { harness } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await context.settle();
    failing.set("nudge", "terminal");
    harness.clock.advance(DAY);
    await context.settle();
    const tallyEntry = registry.aggregates.order?.processes.tally;
    if (tallyEntry === undefined) throw new Error("no process");
    const deployed = await createReactiveHarness({
      registry: {
        aggregates: {
          order: {
            ...orderAggregateEntry(),
            processes: {
              tally: {
                ...tallyEntry,
                module: {
                  ...tallyEntry.module,
                  state: ({ z, instant }: ProcessStateArgs) =>
                    z.object({ seen: z.array(z.string()).default([]), nudge: instant() }),
                },
                deadlines: {},
              },
            },
          },
        },
        readModels: {},
      },
    });
    const { events } = await harness.storage.eventStore.load(stream);
    await deployed.storage.eventStore.append({ ...stream, expectedVersion: 0, events });
    await deployed.processes.replayDeadline({
      payload: { process: "order.tally", aggregateId: "o-1" },
      context: { correlationId: "c", causationId: "c", depth: 0 },
      replay: "r",
    });
    const after = await deployed.storage.eventStore.load(stream);
    expect(after.events.slice(-2).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.deadlineReached,
      PROCESS_EVENTS.resumed,
    ]);
  });

  it("refuse a letter that is not the failure its instance is blocked on, and count nothing behind it", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await failOnFirstPayment(context);
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await settle();
    const [blocking] = await deadLetters.list();
    if (blocking === undefined) throw new Error("no letter");
    const { id: _id, status: _status, parked: _parked, ...rest } = blocking;
    await harness.storage.deadLetterStore.add({ ...rest, id: "stale" });
    expect(await deadLetters.get("stale")).toMatchObject({ parked: 0 });
    expect(await deadLetters.get(blocking.id)).toMatchObject({ parked: 1 });
    await expect(deadLetters.replay("stale")).rejects.toThrow("is failed on another step for o-1");
    await expect(
      harness.processes.replayDeadline({
        payload: { process: "order.tally", aggregateId: "o-1" },
        context: { correlationId: "c", causationId: "c", depth: 0 },
        replay: "r",
        letter: blocking.id,
      }),
    ).rejects.toThrow("has no failed deadline for o-1");
  });

  it("refuse to replay a deadline letter that is not the failure its instance is blocked on", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await context.settle();
    failing.set("nudge", "terminal");
    harness.clock.advance(DAY);
    await context.settle();
    const [letter] = await deadLetters.list();
    await expect(
      harness.processes.replayDeadline({
        payload: { process: "order.tally", aggregateId: "o-1" },
        context: { correlationId: "c", causationId: "c", depth: 0 },
        replay: "r",
        letter: "stale",
      }),
    ).rejects.toThrow("is failed on another step for o-1");
    failing.delete("nudge");
    await deadLetters.replay(letter?.id ?? "");
    expect((await harness.storage.eventStore.load(stream)).events.at(-1)?.type).toBe(
      PROCESS_EVENTS.resumed,
    );
  });

  it("record a parked event's failure once when another drain recorded it first", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...paid, id: "twice", version: order.events.length + 1 }],
    });
    await settle();
    const [letter] = await deadLetters.list();
    const append = harness.storage.eventStore.append;
    harness.storage.eventStore.append = async (args) => {
      const [first] = args.events;
      if (
        first?.type === PROCESS_EVENTS.handled &&
        (first.payload as { eventId?: string }).eventId !== "twice"
      ) {
        whileHandling = async () => {
          await rawAppend(harness, PROCESS_EVENTS.failed, {
            eventId: "twice",
            error: "other drain",
          });
          failingEvents.set("twice", "terminal");
        };
      }
      return append(args);
    };
    await deadLetters.replay(letter?.id ?? "");
    harness.storage.eventStore.append = append;
    const failures = (await harness.storage.eventStore.load(stream)).events.filter(
      (event) =>
        event.type === PROCESS_EVENTS.failed &&
        (event.payload as { eventId?: string }).eventId === "twice",
    );
    expect(failures).toHaveLength(1);
  });

  const letterOfFailure = (id: string, eventId: string) => ({
    id,
    kind: "process" as const,
    subscriber: "order.tally",
    eventId,
    eventType: "OrderPaid",
    aggregateType: "order",
    aggregateId: "o-1",
    errorType: "terminal" as const,
    errorMessage: "elsewhere",
    attempts: 1,
    firstFailedAt: "2026-01-01T00:00:00.000Z",
    lastFailedAt: "2026-01-01T00:00:00.000Z",
  });

  it("park a completing event when the instance fails between handling and completing it", async () => {
    const context = await setUp();
    const { harness, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await context.settle();
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    const load = harness.storage.eventStore.load;
    let loads = 0;
    harness.storage.eventStore.load = async (args) => {
      if (args.aggregateType === stream.aggregateType) {
        loads += 1;
        if (loads === 2) {
          await rawAppend(harness, PROCESS_EVENTS.failed, {
            eventId: "elsewhere",
            error: "elsewhere",
            letter: letterOfFailure("elsewhere-letter", "elsewhere"),
          });
        }
      }
      return load(args);
    };
    await harness.dispatcher.processUntilIdle();
    harness.storage.eventStore.load = load;
    expect((await types()).slice(-2)).toEqual([PROCESS_EVENTS.failed, PROCESS_EVENTS.eventParked]);
  });

  it("file a deadline's letter again when it re-runs after writing the letter failed", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    failing.set("nudge", "terminal");
    const add = harness.storage.deadLetterStore.add;
    let down = true;
    harness.storage.deadLetterStore.add = async (letter) => {
      if (down) {
        down = false;
        throw new Error("store down");
      }
      return add(letter);
    };
    harness.clock.advance(DAY);
    await harness.worker.runOnce();
    expect(down).toBe(false);
    expect(await deadLetters.list()).toEqual([]);
    harness.clock.advance(harness.worker.leaseMs + 1);
    await settle();
    expect(await deadLetters.list()).toMatchObject([{ eventId: "deadline:nudge", parked: 0 }]);
  });

  it("finish a replay whose new failure's letter could not be written, and file that letter anyway", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [{ ...paid, id: "again", version: order.events.length + 1 }],
    });
    await settle();
    const [first] = await deadLetters.list();
    failingEvents.set("again", "terminal");
    const add = harness.storage.deadLetterStore.add;
    let down = true;
    harness.storage.deadLetterStore.add = async (letter) => {
      if (down && letter.eventId === "again") {
        down = false;
        throw new Error("store down");
      }
      return add(letter);
    };
    expect(await deadLetters.replay(first?.id ?? "")).toMatchObject({
      status: "replayed",
      parked: 1,
    });
    expect(down).toBe(false);
    const failed = await deadLetters.list({ status: "failed" });
    expect(failed.map((letter) => letter.eventId)).toEqual(["again"]);
  });

  it("stop a drain once another replay recorded a new failure", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const paid = order.events.find((event) => event.type === "OrderPaid");
    if (paid === undefined) throw new Error("no payment");
    await harness.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: order.events.length,
      events: [1, 2].map((offset) => ({
        ...paid,
        id: `p${offset}`,
        version: order.events.length + offset,
      })),
    });
    await settle();
    const [letter] = await deadLetters.list();
    const append = harness.storage.eventStore.append;
    let other = false;
    harness.storage.eventStore.append = async (args) => {
      const result = await append(args);
      const [first] = args.events;
      if (
        !other &&
        first?.type === PROCESS_EVENTS.handled &&
        (first.payload as { eventId?: string }).eventId === "p1"
      ) {
        other = true;
        await rawAppend(harness, PROCESS_EVENTS.failed, {
          eventId: "p2",
          error: "other replay",
          letter: letterOfFailure("L2", "p2"),
        });
      }
      return result;
    };
    await deadLetters.replay(letter?.id ?? "");
    harness.storage.eventStore.append = append;
    expect(other).toBe(true);
    expect(runs).not.toContain("paid:p2");
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);
  });
});

describe("a parked event that is handled and completes the process", () => {
  it("records both at once, so the completion cannot be lost", async () => {
    let placedFails = true;
    const closer: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            closer: {
              module: {
                config: ({ events }: OrderProcessConfigArgs<"OrderPlaced" | "OrderPaid">) => ({
                  startedBy: [events.order.OrderPlaced],
                  completedBy: [events.order.OrderPaid],
                }),
              },
              handlers: {
                order: {
                  orderPlaced: {
                    handler: () => {
                      if (placedFails) throw new DomainError("not yet");
                    },
                  },
                  orderPaid: { handler: () => undefined },
                },
              },
            },
          },
        },
      },
      readModels: {},
    };
    const harness = await createReactiveHarness({ registry: closer });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.processUntilIdle();
    const placed = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events[0];
    if (placed === undefined) throw new Error("not placed");
    placedFails = false;
    await harness.processes.replay({ process: "order.closer", event: placed, replay: "r" });
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "process:Closer",
      aggregateId: "o-1",
    });
    expect(events.map((event) => [event.type, event.version])).toEqual([
      [PROCESS_EVENTS.started, 1],
      [PROCESS_EVENTS.failed, 2],
      [PROCESS_EVENTS.eventParked, 3],
      [PROCESS_EVENTS.handled, 4],
      [PROCESS_EVENTS.handled, 5],
      [PROCESS_EVENTS.completed, 6],
    ]);
  });
});

type Context = Awaited<ReturnType<typeof setUp>>;

const orderEvents = async ({ harness }: Context) =>
  (await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })).events;

const firstPayment = async (context: Context) => {
  const paid = (await orderEvents(context)).find((event) => event.type === "OrderPaid");
  if (paid === undefined) throw new Error("no payment");
  return paid;
};

const payAgain = async (context: Context, id: string): Promise<void> => {
  const events = await orderEvents(context);
  const paid = await firstPayment(context);
  await context.harness.storage.eventStore.append({
    aggregateType: "order",
    aggregateId: "o-1",
    expectedVersion: events.length,
    events: [
      {
        ...paid,
        id,
        version: events.length + 1,
        timestamp: context.harness.clock.now().toISOString(),
      },
    ],
  });
};

const failOnNudge = async (context: Context) => {
  const { harness, settle } = context;
  await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
  await settle();
  failing.set("nudge", "terminal");
  harness.clock.advance(DAY);
  await settle();
  failing.delete("nudge");
};

describe("replaying a failed process", () => {
  it("log the replay and the resume it ends with", async () => {
    const context = await setUp();
    const { deadLetters, logs } = context;
    await failOnFirstPayment(context);
    const [letter] = await deadLetters.list();

    await deadLetters.replay(letter?.id ?? "");

    expect(logs).toContainEqual({
      level: "info",
      message: "process handler replayed",
      fields: { process: "order.tally", eventId: letter?.eventId },
    });
    expect(logs).toContainEqual({
      level: "info",
      message: "process resumed",
      fields: { process: "order.tally", aggregateId: "o-1" },
    });
  });

  it("run a replayed handler on a running instance, and complete nothing when it was handled", async () => {
    const context = await setUp();
    const { harness, settle, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    await context.pay();
    const paid = await firstPayment(context);

    await harness.processes.replay({ process: "order.tally", event: paid, replay: "r" });
    await harness.processes.replay({ process: "order.tally", event: paid, replay: "r" });

    expect(runs).toEqual([`paid:${paid.id}`]);
    expect(await types()).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.handled,
    ]);
  });

  it("complete an instance whose completing event was handled but its completion not written", async () => {
    reset();
    const tallyEntry = registry.aggregates.order?.processes.tally;
    if (tallyEntry === undefined) throw new Error("no process");
    const archiving: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            tally: {
              ...tallyEntry,
              handlers: {
                order: {
                  ...tallyEntry.handlers.order,
                  orderArchived: { handler: tally("archived") },
                },
              },
            },
          },
        },
      },
      readModels: {},
    };
    const first = await createReactiveHarness({ registry: archiving });
    await first.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await first.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await first.dispatcher.processUntilIdle();
    const order = (
      await first.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events;
    const lifecycle = (await first.storage.eventStore.load(stream)).events;
    expect(lifecycle.at(-1)?.type).toBe(PROCESS_EVENTS.completed);
    const second = await createReactiveHarness({ registry: archiving });
    await second.storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: order,
    });
    await second.storage.eventStore.append({
      ...stream,
      expectedVersion: 0,
      events: lifecycle.slice(0, -1),
    });
    const archived = order.find((event) => event.type === "OrderArchived");
    if (archived === undefined) throw new Error("not archived");
    const replay = () =>
      second.processes.replay({ process: "order.tally", event: archived, replay: "r" });

    await replay();
    await replay();

    const types = (await second.storage.eventStore.load(stream)).events.map((event) => event.type);
    expect(types).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(runs).toEqual([`archived:${archived.id}`]);
  });

  it("stop at a parked event that fails again, even when no letter is named", async () => {
    const context = await setUp();
    const { harness, settle, types } = context;
    await failOnFirstPayment(context);
    await payAgain(context, "after");
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await settle();
    failingEvents.set("after", "terminal");

    await harness.processes.replay({
      process: "order.tally",
      event: await firstPayment(context),
      replay: "r",
    });

    expect(runs.filter((run) => run === "paid:after")).toHaveLength(1);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);
  });

  it("stop at a deadline that fails again while draining, even when no letter is named", async () => {
    const context = await setUp();
    const { harness, settle } = context;
    await failOnFirstPayment(context);
    harness.clock.advance(2 * DAY);
    await payAgain(context, "after");
    await settle();
    failing.set("nudge", "terminal");

    await harness.processes.replay({
      process: "order.tally",
      event: await firstPayment(context),
      replay: "r",
    });

    expect(runs.filter((run) => run === "nudge")).toHaveLength(1);
    expect(runs).not.toContain("paid:after");
    expect((await harness.storage.eventStore.load(stream)).events.at(-1)?.payload).toMatchObject({
      deadline: "nudge",
    });
  });

  it("drain a deadline due at the very moment of a parked event before that event", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await failOnFirstPayment(context);
    harness.clock.advance(DAY);
    await payAgain(context, "after");
    await settle();

    await deadLetters.replay((await deadLetters.list())[0]?.id ?? "");

    expect(runs.slice(-2)).toEqual(["nudge", "paid:after"]);
  });

  it("refuse to replay a deadline the process no longer fails on, and count nothing behind it", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await failOnNudge(context);
    const [letter] = await deadLetters.list();

    expect(await deadLetters.replay(letter?.id ?? "")).toMatchObject({ parked: 0 });
    await expect(
      harness.processes.replayDeadline({
        payload: { process: "order.tally", aggregateId: "o-1" },
        context: { correlationId: "c", causationId: "c", depth: 0 },
        replay: "r-2",
      }),
    ).rejects.toThrow("has no failed deadline for o-1");
  });

  it("run a failed deadline once when its replay broke off after reaching it", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnNudge(context);
    const append = harness.storage.eventStore.append;
    let broken = true;
    harness.storage.eventStore.append = async (args) => {
      if (broken && args.events[0]?.type === PROCESS_EVENTS.resumed) {
        broken = false;
        throw new Error("disk full");
      }
      return append(args);
    };
    const [letter] = await deadLetters.list();
    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow("disk full");
    harness.storage.eventStore.append = append;

    await deadLetters.replay(letter?.id ?? "");

    expect(runs.filter((run) => run === "nudge")).toHaveLength(2);
    expect((await types()).slice(-2)).toEqual([
      PROCESS_EVENTS.deadlineReached,
      PROCESS_EVENTS.resumed,
    ]);
  });
});
