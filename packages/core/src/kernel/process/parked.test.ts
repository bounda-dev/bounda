import { describe, expect, it } from "vitest";
import type { RetryConfig } from "../../config/types.ts";
import { DeadLetterNotRetriableError, ValidationError } from "../../contracts/errors.ts";
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
  if (kind === "terminal") throw new ValidationError(`${label} refuses`, []);
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
    if (failingEvents.get(event.id) === "terminal")
      throw new ValidationError(`${event.id} refuses`, []);
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
              handler: async ({ state }: TallyArgs) => {
                runs.push("nudge");
                const during = whileHandling;
                whileHandling = undefined;
                await during?.();
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
const stream = { aggregateType: "process:order.tally", aggregateId: "o-1" };

const reset = (): void => {
  runs.length = 0;
  failing = new Map();
  failingEvents.clear();
  whileHandling = undefined;
};

const setUp = async (retry: RetryConfig = { strategy: "none" }, concurrencyRetries?: number) => {
  reset();
  const { logger, entries: logs } = createRecordingLogger();
  const harness = await createReactiveHarness({
    registry,
    config: {
      runtime: {
        processes: { retry },
        ...(concurrencyRetries === undefined ? {} : { commands: { concurrencyRetries } }),
      },
    },
    logger,
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
  const settle = async (): Promise<void> => {
    for (;;) {
      await harness.dispatcher.runUntilIdle();
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
    const { harness, deadLetters, settle, types, pay, logs } = context;
    await failOnFirstPayment(context);
    await pay().catch(() => undefined);
    await harness.pipeline.dispatch({ type: "TouchOrder", payload: { orderId: "o-1" } });
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
      events: [{ ...paid, id: "second", version: order.events.length + 1 }],
    });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-2", total: 10 } });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-2" } });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-2" } });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-3" } });
    harness.clock.advance(2 * DAY);
    await settle();

    expect(await types()).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.failed,
      PROCESS_EVENTS.eventParked,
      PROCESS_EVENTS.eventParked,
    ]);
    expect(runs).toEqual([expect.stringMatching(/^paid:/)]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const parkedLog = (eventId: string) => ({
      level: "info",
      message: "process event parked behind a failure",
      fields: { process: "order.tally", aggregateId: "o-1", eventId },
    });
    expect(logs.filter((entry) => entry.message.includes("parked"))).toEqual([
      parkedLog("second"),
      parkedLog(expect.any(String)),
    ]);
    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({ eventType: "OrderPaid", parked: 2 });
    expect(await deadLetters.get(letter?.id ?? "")).toMatchObject({ parked: 2 });
  });

  it("run in order after the failure is retried, before the process resumes and its deadlines with it", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types, logs } = context;
    await failOnFirstPayment(context);
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await settle();
    const [letter] = await deadLetters.list();

    const retried = await deadLetters.retry(letter?.id ?? "");
    expect(retried).toMatchObject({ status: "retried", parked: 0 });
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

    await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect((await types()).slice(-2)).toEqual([PROCESS_EVENTS.handled, PROCESS_EVENTS.resumed]);
    await settle();
    expect(runs.at(-1)).toBe("nudge");
  });

  it("keep one that fails again as the new failure, with the rest still parked behind it", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types, logs } = context;
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
    const retried = await deadLetters.retry(first?.id ?? "");
    expect(retried).toMatchObject({ status: "retried", parked: 2 });
    const [second] = await deadLetters.list({ status: "failed" });
    expect(second).toMatchObject({ eventId: "again-1", parked: 1, errorType: "terminal" });
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);
    expect(logs).toContainEqual({
      level: "warn",
      message: "process dead-lettered",
      fields: { process: "order.tally", eventId: "again-1", errorType: "terminal", attempts: 1 },
    });

    failingEvents.clear();
    await deadLetters.retry(second?.id ?? "");
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

  it("wait behind a failed deadline, which runs first when retried", async () => {
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

    await deadLetters.retry(letter?.id ?? "");
    expect(runs).toEqual(["nudge", "nudge", expect.stringMatching(/^paid:/)]);
    expect((await types()).slice(-3)).toEqual([
      PROCESS_EVENTS.deadlineReached,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.resumed,
    ]);
  });

  it("carry on from where a retry that broke off left them, without running its failure twice", async () => {
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
    await expect(deadLetters.retry(letter?.id ?? "")).rejects.toThrow("disk hiccup");
    harness.storage.eventStore.load = load;
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(2);

    await deadLetters.retry(letter?.id ?? "");
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(2);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.completed);
  });

  it("include one parked while the failure is being retried, before the process resumes", async () => {
    const context = await setUp();
    const { harness, deadLetters, types, logs } = context;
    await failOnFirstPayment(context);
    const [letter] = await deadLetters.list();
    const transact = harness.storage.transact;
    let arrived = false;
    // The archive arrives once the first transaction of the retry that schedules has decided what
    // to write, before it commits.
    harness.storage.transact = (work) =>
      transact(async (tx) => {
        let schedules = false;
        const result = await work({
          ...tx,
          scheduler: {
            ...tx.scheduler,
            schedule: (args) => {
              schedules = true;
              return tx.scheduler.schedule(args);
            },
          },
        });
        if (schedules && !arrived) {
          arrived = true;
          await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
          await harness.dispatcher.runUntilIdle();
        }
        return result;
      });
    await deadLetters.retry(letter?.id ?? "");
    harness.storage.transact = transact;
    expect(arrived).toBe(true);
    expect((await types()).slice(-4)).toEqual([
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.eventParked,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(logs.map((entry) => entry.message)).not.toContain("process resumed");
  });

  it("keep an event that was still retrying when a deadline failed the process", async () => {
    const context = await setUp({ strategy: "fixed", maxAttempts: 5, baseDelay: 60_000 });
    const { harness, deadLetters, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.runUntilIdle();
    failing.set("paid", "retriable");
    failing.set("nudge", "terminal");
    await context.pay();
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(DAY);
    for (let round = 0; round < 12; round += 1) await harness.worker.runOnce();
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);

    failing.delete("paid");
    harness.clock.advance(60_000);
    await harness.dispatcher.runUntilIdle();
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
    await expect(deadLetters.retry(letter?.id ?? "")).rejects.toThrow(
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
    await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect(await deadLetters.list({ status: "failed" })).toMatchObject([
      { eventId: "flaky", errorType: "retriable_exhausted", errorMessage: "flaky is down" },
    ]);
  });

  it("run a parked event again on the instance as it now is when a park got there first", async () => {
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
    await harness.dispatcher.runUntilIdle();
    whileHandling = async () => {
      whileHandling = async () => {
        await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
        await harness.dispatcher.runUntilIdle();
      };
    };
    await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect(runs.filter((run) => run === "paid:late-payment")).toHaveLength(2);
    expect((await types()).slice(-4)).toEqual([
      PROCESS_EVENTS.eventParked,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
    expect(await deadLetters.list({ status: "failed" })).toEqual([]);
  });

  it("let a failure to resume reach the caller, and resume on the next retry", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnFirstPayment(context);
    const schedule = harness.storage.scheduler.schedule;
    let writes = 0;
    harness.storage.scheduler.schedule = async (args) => {
      writes += 1;
      if (writes === 1) throw new Error("disk full");
      return schedule(args);
    };
    const [letter] = await deadLetters.list();
    await expect(deadLetters.retry(letter?.id ?? "")).rejects.toThrow("disk full");
    harness.storage.scheduler.schedule = schedule;
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.handled);
    await deadLetters.retry(letter?.id ?? "");
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
                      throw new ValidationError("no", []);
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
    await harness.dispatcher.runUntilIdle();
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await harness.dispatcher.runUntilIdle();
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "process:order.quiet",
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
    await deployed.processes.retry({ process: "order.tally", event: failure, retryId: "r" });
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

  it("refuse to retry a letter of an instance that is failed on another step", async () => {
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
      harness.processes.retry({
        process: "order.tally",
        event: order.events[0] as NonNullable<(typeof order.events)[number]>,
        retryId: "r",
      }),
    ).rejects.toThrow(
      new DeadLetterNotRetriableError(
        'Process "order.tally" is failed on another step for o-1; retry the dead letter of that failure first',
      ),
    );
    expect(await deadLetters.list()).toMatchObject([{ eventId: "deadline:nudge" }]);
  });

  it("say a retry failed again even when the only parked event is the one that failed", async () => {
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
    const retried = await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect(retried).toMatchObject({ status: "retried", parked: 1 });
    expect(await deadLetters.list({ status: "failed" })).toMatchObject([
      { eventId: "only", parked: 0 },
    ]);
  });

  it("finish a retry during which an event was parked, running the failed handler again on the instance as it now is", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnFirstPayment(context);
    whileHandling = async () => {
      await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
      await harness.dispatcher.runUntilIdle();
    };
    await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(3);
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
    await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect(runs.slice(1)).toEqual([expect.stringMatching(/^paid:/), "nudge", "paid:later"]);
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
    await deployed.processes.retry({ process: "order.tally", event: failure, retryId: "r" });
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
    const retried = await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect(retried.parked).toBe(2);
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
    await deadLetters.retry(letter?.id ?? "");
    expect(runs.slice(-2)).toEqual(["nudge", "paid:after"]);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
  });

  it("stop a retry, writing nothing more, when something other than a park ended the instance meanwhile", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
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
    expect((await deadLetters.retry((await deadLetters.list())[0]?.id ?? "")).status).toBe(
      "retried",
    );
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.completed);
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(2);
  });

  it("leave a parked event to the drain that handled it first", async () => {
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
      events: [{ ...paid, id: "shared", version: order.events.length + 1 }],
    });
    await context.settle();
    const [letter] = await deadLetters.list();
    whileHandling = async () => {
      whileHandling = async () => {
        await rawAppend(harness, PROCESS_EVENTS.handled, {
          state: { seen: [], nudge: null },
          eventId: "shared",
        });
        failingEvents.set("shared", "terminal");
      };
    };
    await deadLetters.retry(letter?.id ?? "");
    expect(await deadLetters.list({ status: "failed" })).toEqual([]);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
  });

  it("run a parked event once when another drain handled it while it ran", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnFirstPayment(context);
    await payAgain(context, "shared");
    await context.settle();
    const [letter] = await deadLetters.list();
    whileHandling = async () => {
      whileHandling = async () => {
        await rawAppend(harness, PROCESS_EVENTS.handled, {
          state: { seen: [], nudge: null },
          eventId: "shared",
        });
      };
    };
    await deadLetters.retry(letter?.id ?? "");
    expect(runs.filter((run) => run === "paid:shared")).toHaveLength(1);
    const handled = (await harness.storage.eventStore.load(stream)).events.filter(
      (event) =>
        event.type === PROCESS_EVENTS.handled &&
        (event.payload as { eventId?: string }).eventId === "shared",
    );
    expect(handled).toHaveLength(1);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
  });

  it("leave a parked event that fails alone when the instance resumed meanwhile", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnFirstPayment(context);
    await payAgain(context, "late");
    await context.settle();
    const [letter] = await deadLetters.list();
    whileHandling = async () => {
      whileHandling = async () => {
        await rawAppend(harness, PROCESS_EVENTS.resumed, {});
        failingEvents.set("late", "terminal");
      };
    };
    expect((await deadLetters.retry(letter?.id ?? "")).status).toBe("retried");
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
    expect(await deadLetters.list({ status: "failed" })).toEqual([]);
  });

  it("let a store failure while draining reach the caller, and drain again on the next retry", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    await payAgain(context, "drained");
    await settle();
    const [letter] = await deadLetters.list();
    const cancel = harness.storage.scheduler.cancel;
    let cancels = 0;
    harness.storage.scheduler.cancel = async (key) => {
      cancels += 1;
      if (cancels === 2) throw new Error("store down");
      return cancel(key);
    };
    await expect(deadLetters.retry(letter?.id ?? "")).rejects.toThrow("store down");
    harness.storage.scheduler.cancel = cancel;
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.handled);
    expect(runs.filter((run) => run === "paid:drained")).toHaveLength(1);
    await deadLetters.retry(letter?.id ?? "");
    expect(runs.filter((run) => run === "paid:drained")).toHaveLength(2);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
  });

  it("record a drained deadline's failure once when another drain recorded it first", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    harness.clock.advance(DAY);
    await payAgain(context, "later");
    await settle();
    const nudgeAt = new Date(Date.parse("2026-01-01T00:00:00.000Z") + DAY).toISOString();
    whileHandling = async () => {
      whileHandling = async () => {
        await rawAppend(harness, PROCESS_EVENTS.failed, {
          deadline: "nudge",
          at: nudgeAt,
          error: "other drain",
          letterId: "other",
        });
        failing.set("nudge", "terminal");
      };
    };
    await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect(runs.slice(1)).toEqual([expect.stringMatching(/^paid:/), "nudge"]);
    const failures = (await harness.storage.eventStore.load(stream)).events.filter(
      (event) => (event.payload as { deadline?: string }).deadline === "nudge",
    );
    expect(failures).toHaveLength(1);
    expect((await deadLetters.list()).map((letter) => letter.eventId)).not.toContain(
      "deadline:nudge",
    );
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);
  });

  it("leave a drained deadline to the drain that reached it first", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    harness.clock.advance(DAY);
    await payAgain(context, "later");
    await settle();
    const nudgeAt = new Date(Date.parse("2026-01-01T00:00:00.000Z") + DAY).toISOString();
    let reached = false;
    whileHandling = async () => {
      whileHandling = async () => {
        reached = true;
        await rawAppend(harness, PROCESS_EVENTS.deadlineReached, {
          field: "nudge",
          at: nudgeAt,
          state: { seen: [], nudge: null },
        });
        failing.set("nudge", "terminal");
      };
    };
    await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect(reached).toBe(true);
    expect(runs.slice(1)).toEqual([expect.stringMatching(/^paid:/), "nudge", "paid:later"]);
    expect(
      (await harness.storage.eventStore.load(stream)).events.filter(
        (event) => event.type === PROCESS_EVENTS.deadlineReached,
      ),
    ).toHaveLength(1);
    expect((await deadLetters.list()).map((letter) => letter.eventId)).not.toContain(
      "deadline:nudge",
    );
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
  });

  it("run a drained deadline once when another drain reached it while it ran", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    harness.clock.advance(DAY);
    await payAgain(context, "later");
    await settle();
    const nudgeAt = new Date(Date.parse("2026-01-01T00:00:00.000Z") + DAY).toISOString();
    whileHandling = async () => {
      whileHandling = async () => {
        await rawAppend(harness, PROCESS_EVENTS.deadlineReached, {
          field: "nudge",
          at: nudgeAt,
          state: { seen: [], nudge: null },
        });
      };
    };
    await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");
    expect(runs.slice(1)).toEqual([expect.stringMatching(/^paid:/), "nudge", "paid:later"]);
    expect(
      (await harness.storage.eventStore.load(stream)).events.filter(
        (event) => event.type === PROCESS_EVENTS.deadlineReached,
      ),
    ).toHaveLength(1);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
  });

  it("leave a drained deadline that fails alone when the instance resumed meanwhile", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await failOnFirstPayment(context);
    harness.clock.advance(DAY);
    await payAgain(context, "later");
    await settle();
    whileHandling = async () => {
      whileHandling = async () => {
        await rawAppend(harness, PROCESS_EVENTS.resumed, {});
        failing.set("nudge", "terminal");
      };
    };
    expect((await deadLetters.retry((await deadLetters.list())[0]?.id ?? "")).status).toBe(
      "retried",
    );
    expect(runs.slice(1)).toEqual([expect.stringMatching(/^paid:/), "nudge"]);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.resumed);
    expect((await deadLetters.list()).map((letter) => letter.eventId)).not.toContain(
      "deadline:nudge",
    );
  });

  it("file the letter but no second ProcessFailed when the instance failed on something else meanwhile", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    failing.set("paid", "terminal");
    const add = harness.storage.deadLetterStore.add;
    let raced = false;
    harness.storage.deadLetterStore.add = async (letter) => {
      const filed = add(letter);
      if (!raced) {
        raced = true;
        await rawAppend(harness, PROCESS_EVENTS.failed, { eventId: "elsewhere", error: "x" });
      }
      return filed;
    };
    await context.pay();
    await harness.dispatcher.runUntilIdle();
    harness.storage.deadLetterStore.add = add;
    expect(raced).toBe(true);
    expect((await deadLetters.list()).map((letter) => letter.eventType)).toEqual(["OrderPaid"]);
    expect((await types()).filter((type) => type === PROCESS_EVENTS.failed)).toHaveLength(1);
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(1);
  });

  it("count nothing parked for a letter whose process is gone", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await harness.storage.deadLetterStore.add({
      id: "orphan-letter",
      kind: "process",
      handler: "order.gone",
      eventId: "deadline:x",
      eventType: "bounda.ProcessDeadline",
      aggregateType: "process:order.gone",
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

  it("file one letter, without running the handler again, when recording a terminal failure lost a race", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    failing.set("paid", "terminal");
    const add = harness.storage.deadLetterStore.add;
    let raced = false;
    harness.storage.deadLetterStore.add = async (letter) => {
      const filed = add(letter);
      if (!raced) {
        raced = true;
        await rawAppend(harness, PROCESS_EVENTS.handled, { state: { seen: [], nudge: null } });
      }
      return filed;
    };
    await context.pay();
    await harness.dispatcher.runUntilIdle();
    harness.storage.deadLetterStore.add = add;
    await harness.dispatcher.runUntilIdle();
    expect(raced).toBe(true);
    expect((await deadLetters.list()).map((letter) => letter.eventType)).toEqual(["OrderPaid"]);
    harness.clock.advance(harness.config.runtime.processes.handlerTimeoutMs * 2 + 1);
    await harness.dispatcher.runUntilIdle();
    expect(await deadLetters.list()).toHaveLength(1);
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(1);
    expect((await context.types()).at(-1)).toBe(PROCESS_EVENTS.failed);
  });

  it("file no letter for a deadline whose process failed on something else meanwhile", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    failing.set("nudge", "terminal");
    const add = harness.storage.deadLetterStore.add;
    let raced = false;
    harness.storage.deadLetterStore.add = async (letter) => {
      const filed = add(letter);
      if (!raced && letter.eventId === "deadline:nudge") {
        raced = true;
        await rawAppend(harness, PROCESS_EVENTS.failed, { eventId: "elsewhere", error: "x" });
      }
      return filed;
    };
    harness.clock.advance(DAY);
    await settle();
    harness.storage.deadLetterStore.add = add;
    expect(raced).toBe(true);
    expect((await deadLetters.list()).map((letter) => letter.eventId)).not.toContain(
      "deadline:nudge",
    );
  });

  it("give up again, after the lease, when writing the give-up was cut short", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, types } = context;
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
    await harness.dispatcher.runUntilIdle();
    expect(cut).toBe(false);
    expect(await deadLetters.list()).toEqual([]);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.handled);
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(1);
    harness.clock.advance(harness.config.runtime.processes.handlerTimeoutMs * 2 + 1);
    await harness.dispatcher.runUntilIdle();
    expect(await deadLetters.list()).toMatchObject([
      { eventType: "OrderPaid", status: "failed", errorMessage: "paid refuses" },
    ]);
    expect((await types()).filter((type) => type === PROCESS_EVENTS.failed)).toHaveLength(1);
    expect(runs.filter((run) => run.startsWith("paid:"))).toHaveLength(2);
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
    const cancel = harness.storage.scheduler.cancel;
    let raced = false;
    harness.storage.scheduler.cancel = async (key) => {
      if (!raced) {
        raced = true;
        await rawAppend(harness, PROCESS_EVENTS.resumed, {});
      }
      return cancel(key);
    };
    await harness.dispatcher.runUntilIdle();
    harness.storage.scheduler.cancel = cancel;
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
    await deployed.processes.retryDeadline({
      payload: { process: "order.tally", aggregateId: "o-1" },
      context: { correlationId: "c", causationId: "c", depth: 0 },
      retryId: "r",
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
    await expect(deadLetters.retry("stale")).rejects.toThrow("is failed on another step for o-1");
    await expect(
      harness.processes.retryDeadline({
        payload: { process: "order.tally", aggregateId: "o-1" },
        context: { correlationId: "c", causationId: "c", depth: 0 },
        retryId: "r",
        letter: blocking.id,
      }),
    ).rejects.toThrow("has no failed deadline for o-1");
  });

  it("refuse to retry a deadline letter that is not the failure its instance is blocked on", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await context.settle();
    failing.set("nudge", "terminal");
    harness.clock.advance(DAY);
    await context.settle();
    const [letter] = await deadLetters.list();
    await expect(
      harness.processes.retryDeadline({
        payload: { process: "order.tally", aggregateId: "o-1" },
        context: { correlationId: "c", causationId: "c", depth: 0 },
        retryId: "r",
        letter: "stale",
      }),
    ).rejects.toThrow("is failed on another step for o-1");
    failing.delete("nudge");
    await deadLetters.retry(letter?.id ?? "");
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
    whileHandling = async () => {
      whileHandling = async () => {
        await rawAppend(harness, PROCESS_EVENTS.failed, {
          eventId: "twice",
          error: "other drain",
        });
        failingEvents.set("twice", "terminal");
      };
    };
    await deadLetters.retry(letter?.id ?? "");
    const failures = (await harness.storage.eventStore.load(stream)).events.filter(
      (event) =>
        event.type === PROCESS_EVENTS.failed &&
        (event.payload as { eventId?: string }).eventId === "twice",
    );
    expect(failures).toHaveLength(1);
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
            letterId: "elsewhere-letter",
          });
        }
      }
      return load(args);
    };
    await harness.dispatcher.runUntilIdle();
    harness.storage.eventStore.load = load;
    expect((await types()).slice(-2)).toEqual([PROCESS_EVENTS.failed, PROCESS_EVENTS.eventParked]);
  });

  it("give up a deadline again, after its lease, when writing the give-up was cut short", async () => {
    const context = await setUp();
    const { harness, deadLetters, settle, logs } = context;
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
    expect(logs).toContainEqual({
      level: "error",
      message: "scheduled command could not be settled; its lease will lapse",
      fields: expect.objectContaining({ command: "bounda.ProcessDeadline", message: "store down" }),
    });
    harness.clock.advance(harness.worker.leaseMs + 1);
    await settle();
    expect(await deadLetters.list()).toMatchObject([{ eventId: "deadline:nudge", parked: 0 }]);
  });

  it("write a drained step's failure and its letter together, or neither, and record both on the next retry", async () => {
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
    await expect(deadLetters.retry(first?.id ?? "")).rejects.toThrow("store down");
    expect(down).toBe(false);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.handled);
    expect(await deadLetters.list({ status: "failed" })).toMatchObject([{ id: first?.id }]);
    expect(await deadLetters.retry(first?.id ?? "")).toMatchObject({
      status: "retried",
      parked: 1,
    });
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);
    const failed = await deadLetters.list({ status: "failed" });
    expect(failed.map((letter) => letter.eventId)).toEqual(["again"]);
    expect(runs.filter((run) => run === "paid:again")).toHaveLength(2);
  });

  it("stop a drain once another retry recorded a new failure", async () => {
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
    let other = false;
    whileHandling = async () => {
      whileHandling = async () => {
        other = true;
        await rawAppend(harness, PROCESS_EVENTS.failed, {
          eventId: "p2",
          error: "other retry",
          letterId: "L2",
        });
      };
    };
    await deadLetters.retry(letter?.id ?? "");
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
                      if (placedFails) throw new ValidationError("not yet", []);
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
    await harness.dispatcher.runUntilIdle();
    const placed = (
      await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
    ).events[0];
    if (placed === undefined) throw new Error("not placed");
    placedFails = false;
    await harness.processes.retry({ process: "order.closer", event: placed, retryId: "r" });
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "process:order.closer",
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

describe("retrying a failed process", () => {
  it("log the retry and the resume it ends with", async () => {
    const context = await setUp();
    const { deadLetters, logs } = context;
    await failOnFirstPayment(context);
    const [letter] = await deadLetters.list();

    await deadLetters.retry(letter?.id ?? "");

    expect(logs).toContainEqual({
      level: "info",
      message: "process handler retried",
      fields: { process: "order.tally", eventId: letter?.eventId },
    });
    expect(logs).toContainEqual({
      level: "info",
      message: "process resumed",
      fields: { process: "order.tally", aggregateId: "o-1" },
    });
  });

  it("run a retried handler on a running instance, and complete nothing when it was handled", async () => {
    const context = await setUp();
    const { harness, settle, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    await context.pay();
    const paid = await firstPayment(context);

    await harness.processes.retry({ process: "order.tally", event: paid, retryId: "r" });
    await harness.processes.retry({ process: "order.tally", event: paid, retryId: "r" });

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
    await first.dispatcher.runUntilIdle();
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
    const retry = () =>
      second.processes.retry({ process: "order.tally", event: archived, retryId: "r" });

    await retry();
    await retry();

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

    await harness.processes.retry({
      process: "order.tally",
      event: await firstPayment(context),
      retryId: "r",
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

    await harness.processes.retry({
      process: "order.tally",
      event: await firstPayment(context),
      retryId: "r",
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

    await deadLetters.retry((await deadLetters.list())[0]?.id ?? "");

    expect(runs.slice(-2)).toEqual(["nudge", "paid:after"]);
  });

  it("refuse to retry a deadline the process no longer fails on, and count nothing behind it", async () => {
    const context = await setUp();
    const { harness, deadLetters } = context;
    await failOnNudge(context);
    const [letter] = await deadLetters.list();

    expect(await deadLetters.retry(letter?.id ?? "")).toMatchObject({ parked: 0 });
    await expect(
      harness.processes.retryDeadline({
        payload: { process: "order.tally", aggregateId: "o-1" },
        context: { correlationId: "c", causationId: "c", depth: 0 },
        retryId: "r-2",
      }),
    ).rejects.toThrow("has no failed deadline for o-1");
  });

  it("run a failed deadline once when its retry broke off after reaching it", async () => {
    const context = await setUp();
    const { harness, deadLetters, types } = context;
    await failOnNudge(context);
    const schedule = harness.storage.scheduler.schedule;
    let writes = 0;
    harness.storage.scheduler.schedule = async (args) => {
      writes += 1;
      if (writes === 1) throw new Error("disk full");
      return schedule(args);
    };
    const [letter] = await deadLetters.list();
    await expect(deadLetters.retry(letter?.id ?? "")).rejects.toThrow("disk full");
    harness.storage.scheduler.schedule = schedule;

    await deadLetters.retry(letter?.id ?? "");

    expect(runs.filter((run) => run === "nudge")).toHaveLength(2);
    expect((await types()).slice(-2)).toEqual([
      PROCESS_EVENTS.deadlineReached,
      PROCESS_EVENTS.resumed,
    ]);
  });
});

describe("an event handled while a deadline writes to its instance", () => {
  const reachDeadline = (context: Context) => () =>
    context.harness.processes.handleDeadline({
      payload: { process: "order.tally", aggregateId: "o-1" },
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });

  it("runs again on the instance as it now is, without spending an attempt", async () => {
    const context = await setUp();
    const { harness, settle, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    harness.clock.advance(DAY);
    whileHandling = reachDeadline(context);

    await context.pay();
    await harness.dispatcher.runUntilIdle();

    const paid = await firstPayment(context);
    expect(runs).toEqual([`paid:${paid.id}`, "nudge", `paid:${paid.id}`]);
    expect(await types()).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.deadlineReached,
      PROCESS_EVENTS.handled,
    ]);
    expect(
      await harness.storage.inboxLedger.get({ handler: "order.tally", eventId: paid.id }),
    ).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(await harness.storage.deadLetterStore.list()).toEqual([]);
  });

  it("spends an attempt once the races allowed run out", async () => {
    const context = await setUp({ strategy: "none" }, 1);
    const { harness, settle, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    let races = 2;
    const touch = async (): Promise<void> => {
      races -= 1;
      if (races > 0) whileHandling = touch;
      const { events } = await harness.storage.eventStore.load(stream);
      const [started] = events;
      if (started === undefined) throw new Error("not started");
      await harness.storage.eventStore.append({
        ...stream,
        expectedVersion: events.length,
        events: [
          {
            ...started,
            id: `touch-${races}`,
            version: events.length + 1,
            type: "ProcessTouched",
            payload: {},
          },
        ],
      });
    };
    whileHandling = touch;

    await context.pay();
    await harness.dispatcher.runUntilIdle();
    await harness.dispatcher.runUntilIdle();

    const paid = await firstPayment(context);
    expect(runs).toEqual([`paid:${paid.id}`, `paid:${paid.id}`]);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.failed);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { eventId: paid.id, errorType: "retriable_exhausted" },
    ]);
  });

  it("runs no more once the deadline ended the process", async () => {
    const context = await setUp();
    const { harness, settle, types } = context;
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle();
    harness.clock.advance(31 * DAY);
    whileHandling = async () => {
      await reachDeadline(context)();
      await reachDeadline(context)();
    };

    await context.pay();
    await harness.dispatcher.runUntilIdle();
    await harness.dispatcher.runUntilIdle();

    const paid = await firstPayment(context);
    expect(runs.filter((run) => run === `paid:${paid.id}`)).toHaveLength(1);
    expect((await types()).at(-1)).toBe(PROCESS_EVENTS.timedOut);
  });
});
