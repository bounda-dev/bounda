import { describe, expect, it } from "vitest";
import type { RetryConfig } from "../../config/types.ts";
import { ConcurrencyError, DomainError } from "../../contracts/errors.ts";
import type { Instant } from "../../contracts/instant.ts";
import type { ProcessAfterFunction, ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { createDeadLetters } from "../dead-letters/dead-letters.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { type OrderProcessConfigArgs, orderAggregateEntry } from "../test-support.ts";
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

const tally =
  (label: string) =>
  ({ state, event }: TallyArgs): TallyState => {
    runs.push(`${label}:${event.id}`);
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

const setUp = async (retry: RetryConfig = { strategy: "none" }) => {
  runs.length = 0;
  failing = new Map();
  failingEvents.clear();
  const harness = await createReactiveHarness({
    registry,
    config: { runtime: { processes: { retry } } },
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
  return { harness, deadLetters, settle, types, pay };
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
    const { harness, deadLetters, settle, types } = context;
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
      PROCESS_EVENTS.completed,
    ]);
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
    expect(replayed).toMatchObject({ status: "replayed", parked: 1 });
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
    harness.clock.advance(40 * DAY);
    await settle();
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.eventParked);
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
    expect((await types()).slice(-3)).toEqual([
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.eventParked,
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

  it("handle a parked event again when another write to the instance got there first", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnFirstPayment(context);
    await harness.pipeline
      .dispatch({ type: "PayOrder", payload: { orderId: "o-1", method: "card" } })
      .catch(() => undefined);
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
        throw new ConcurrencyError({
          streamId: `${stream.aggregateType}:${stream.aggregateId}`,
          expectedVersion: args.expectedVersion,
          actualVersion: args.expectedVersion + 1,
        });
      }
      return append(args);
    };
    await deadLetters.replay((await deadLetters.list())[0]?.id ?? "");
    harness.storage.eventStore.append = append;
    expect(raced).toBe(true);
    expect(runs.filter((run) => run === "paid:late-payment")).toHaveLength(2);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
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
});
