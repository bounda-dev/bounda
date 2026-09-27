import { describe, expect, it } from "vitest";
import type { RetryConfig } from "../../config/types.ts";
import { DomainError } from "../../contracts/errors.ts";
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
const failingEvents = new Set<string>();

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
    if (failingEvents.has(event.id)) throw new DomainError(`${event.id} refuses`);
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

    failingEvents.add("again-1");
    const replayed = await deadLetters.replay(first?.id ?? "");
    expect(replayed).toMatchObject({ status: "replayed", parked: 1 });
    const [second] = await deadLetters.list({ status: "failed" });
    expect(second).toMatchObject({ eventId: "again-1", parked: 1 });
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
    const [letter] = await deadLetters.list();
    expect((await deadLetters.discard(letter?.id ?? "")).status).toBe("discarded");
    await pay().catch(() => undefined);
    harness.clock.advance(40 * DAY);
    await settle();
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);
    expect(runs).toHaveLength(1);
    expect(await deadLetters.list({ status: "discarded" })).toMatchObject([{ parked: 0 }]);
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
});
