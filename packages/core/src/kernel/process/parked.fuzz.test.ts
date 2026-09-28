import { describe, expect, it } from "vitest";
import { ConcurrencyError, DomainError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Instant } from "../../contracts/instant.ts";
import type { ProcessAfterFunction, ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { createDeadLetters } from "../dead-letters/dead-letters.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { type OrderProcessConfigArgs, orderAggregateEntry } from "../test-support.ts";
import { foldProcess, PROCESS_EVENTS } from "./lifecycle.ts";

interface LedgerState {
  readonly seen: readonly string[];
  readonly nudges: number;
  readonly nudge: Instant | null;
}

interface LedgerArgs {
  readonly state: LedgerState;
  readonly event: { readonly id: string };
  readonly after: ProcessAfterFunction;
}

type Failure = "terminal" | "retriable";

const failing = new Map<string, Failure>();
let nudgeFails: Failure | undefined;

const fail = (kind: Failure | undefined, what: string): void => {
  if (kind === "terminal") throw new DomainError(`${what} refuses`);
  if (kind === "retriable") throw new Error(`${what} is down`);
};

const registry: Registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      processes: {
        ledger: {
          module: {
            config: ({
              events,
            }: OrderProcessConfigArgs<"OrderPlaced" | "OrderPaid" | "OrderArchived">) => ({
              startedBy: [events.order.OrderPlaced],
              completedBy: [events.order.OrderArchived],
              timeout: "3650d",
            }),
            state: ({ z, deadline }: ProcessStateArgs) =>
              z.object({
                seen: z.array(z.string()).default([]),
                nudges: z.int().default(0),
                nudge: deadline(),
              }),
          },
          handlers: {
            order: {
              orderPlaced: {
                handler: ({ state, after: later }: LedgerArgs) => ({
                  ...state,
                  nudge: later("1d"),
                }),
              },
              orderPaid: {
                handler: async ({ state, event }: LedgerArgs) => {
                  await Promise.resolve();
                  fail(failing.get(event.id), event.id);
                  await Promise.resolve();
                  return { ...state, seen: [...state.seen, event.id] };
                },
              },
            },
          },
          deadlines: {
            nudge: {
              handler: async ({ state, after: later }: LedgerArgs) => {
                await Promise.resolve();
                fail(nudgeFails, "nudge");
                return { ...state, nudges: state.nudges + 1, nudge: later("1d") };
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
};

const random = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const ORDERS = ["o-1", "o-2"];
const seen = new Map<string, number>();
const tally = (what: string, count = 1): void => {
  seen.set(what, (seen.get(what) ?? 0) + count);
};
const HOUR = 3_600_000;
const STEPS = Number(process.env.FUZZ_STEPS ?? 60);

const run = async (seed: number): Promise<void> => {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  failing.clear();
  nudgeFails = undefined;
  const harness = await createReactiveHarness({
    registry,
    config: {
      runtime: {
        processes: {
          retry: { strategy: "fixed", maxAttempts: 2, baseDelay: 1_000, maxDelay: 1_000 },
        },
      },
    },
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
  const add = harness.storage.deadLetterStore.add;
  let storeFailures = 0;
  harness.storage.deadLetterStore.add = async (letter) => {
    if (storeFailures > 0) {
      storeFailures -= 1;
      throw new Error("dead-letter store is down");
    }
    return add(letter);
  };
  const paid = new Map<string, string[]>(ORDERS.map((order) => [order, []]));
  const archived = new Set<string>();
  const discarded = new Set<string>();
  let counter = 0;

  for (const order of ORDERS) {
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: order, total: 10 } });
  }
  await harness.pipeline.dispatch({
    type: "PayOrder",
    payload: { orderId: "o-1", method: "card" },
  });
  const template = (
    await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
  ).events.find((event) => event.type === "OrderPaid") as StoredEvent;
  (paid.get("o-1") as string[]).push(template.id);

  const appendPaid = async (order: string): Promise<void> => {
    counter += 1;
    const id = `pay-${seed}-${counter}`;
    for (;;) {
      const { events } = await harness.storage.eventStore.load({
        aggregateType: "order",
        aggregateId: order,
      });
      try {
        await harness.storage.eventStore.append({
          aggregateType: "order",
          aggregateId: order,
          expectedVersion: events.length,
          events: [
            {
              ...template,
              id,
              aggregateId: order,
              version: events.length + 1,
              timestamp: harness.clock.now().toISOString(),
            },
          ],
        });
        break;
      } catch (error) {
        if (!(error instanceof ConcurrencyError)) throw error;
      }
    }
    (paid.get(order) as string[]).push(id);
    if (next() < 0.25) failing.set(id, next() < 0.5 ? "terminal" : "retriable");
  };

  const archive = async (order: string): Promise<void> => {
    if (archived.has(order)) return;
    archived.add(order);
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: order } });
  };

  const discardOne = async (): Promise<void> => {
    const failed = await harness.storage.deadLetterStore.list({ status: "failed" });
    if (failed.length === 0) return;
    const letter = pick(failed);
    await deadLetters.discard(letter.id).catch(() => undefined);
    discarded.add(letter.id);
  };

  const replayOne = async (): Promise<void> => {
    const failed = await harness.storage.deadLetterStore.list({ status: "failed" });
    if (failed.length === 0) return;
    await deadLetters.replay(pick(failed).id).catch(() => undefined);
  };

  const operations: readonly (() => Promise<unknown>)[] = [
    () => appendPaid(pick(ORDERS)),
    () => appendPaid(pick(ORDERS)),
    () => harness.dispatcher.processOnce(),
    () => harness.dispatcher.processOnce(),
    () => harness.worker.runOnce(),
    replayOne,
    replayOne,
    async () => harness.clock.advance(Math.floor(next() * 30) * HOUR),
    async () => {
      const ids = [...failing.keys()];
      if (ids.length > 0) failing.delete(pick(ids));
    },
    async () => {
      nudgeFails = next() < 0.3 ? pick<Failure>(["terminal", "retriable"]) : undefined;
    },
    async () => {
      storeFailures = next() < 0.2 ? 1 : 0;
    },
    async () => {
      if (next() < 0.15) await archive(pick(ORDERS));
    },
    async () => {
      if (next() < 0.1) await discardOne();
    },
  ];

  for (let step = 0; step < STEPS; step += 1) {
    if (next() < 0.3) await Promise.all([pick(operations)(), pick(operations)()]);
    else await pick(operations)();
  }

  failing.clear();
  nudgeFails = undefined;
  storeFailures = 0;
  const settled = async (): Promise<boolean> => {
    const statuses = await Promise.all(
      ORDERS.map(async (order) => {
        const { events } = await harness.storage.eventStore.load({
          aggregateType: "process:Ledger",
          aggregateId: order,
        });
        const instance = foldProcess({ initialState: {}, events });
        const blocking = instance.failure?.letter?.id;
        const letter =
          blocking === undefined ? null : await harness.storage.deadLetterStore.get(blocking);
        return instance.status === "failed" && letter?.status === "discarded"
          ? "abandoned"
          : instance.status;
      }),
    );
    const failed = await harness.storage.deadLetterStore.list({ status: "failed" });
    const lag = (await harness.dispatcher.getLag()).maxLag;
    return statuses.every((status) => status !== "failed") && failed.length === 0 && lag === 0;
  };
  let rounds = 0;
  for (; rounds < 40 && (rounds === 0 || !(await settled())); rounds += 1) {
    await harness.dispatcher.processUntilIdle();
    for (let pass = 0; pass < 12; pass += 1) await harness.worker.runOnce();
    for (const letter of await harness.storage.deadLetterStore.list({ status: "failed" })) {
      await deadLetters.replay(letter.id).catch(() => undefined);
    }
    harness.clock.advance(harness.worker.leaseMs + 1);
  }
  const where = `seed ${seed}`;
  const summary = async (): Promise<string> => {
    const lines = await Promise.all(
      ORDERS.map(async (order) => {
        const { events } = await harness.storage.eventStore.load({
          aggregateType: "process:Ledger",
          aggregateId: order,
        });
        return `${order}: ${events
          .map((event) => {
            const payload = event.payload as {
              eventId?: string;
              field?: string;
              letter?: { id: string };
            };
            const letter = payload.letter === undefined ? "" : `[${payload.letter.id}]`;
            return `${event.type.replace("Process", "")}:${payload.eventId ?? payload.field ?? ""}${letter}`;
          })
          .join(" ")}`;
      }),
    );
    const letters = (await harness.storage.deadLetterStore.list()).map(
      (letter) => `${letter.id}:${letter.status}:${letter.eventId}`,
    );
    return [...lines, `letters: ${letters.join(" ")}`].join("\n");
  };
  const check = async (): Promise<void> => {
    expect(rounds, `${where}: never settled`).toBeLessThan(40);

    const carried = new Set<string>();
    for (const order of ORDERS) {
      const { events } = await harness.storage.eventStore.load({
        aggregateType: "process:Ledger",
        aggregateId: order,
      });
      for (const event of events) tally(event.type);
      events.forEach((event, index) => {
        if (event.type === PROCESS_EVENTS.resumed) {
          const before = foldProcess({ initialState: {}, events: events.slice(0, index) });
          expect(before.parked, `${where}: ${order} resumed with events parked`).toEqual([]);
        }
        const letter = (event.payload as { letter?: { id: string } }).letter;
        if (event.type === PROCESS_EVENTS.failed && letter !== undefined) carried.add(letter.id);
      });
      const handled = events
        .filter((event) => event.type === PROCESS_EVENTS.handled)
        .map((event) => (event.payload as { eventId?: string }).eventId)
        .filter((id) => id?.startsWith("pay-") === true || id === template.id);
      const instance = foldProcess({ initialState: {}, events });
      const blocking = instance.failure?.letter?.id;
      const abandoned =
        instance.status === "failed" &&
        blocking !== undefined &&
        (await harness.storage.deadLetterStore.get(blocking))?.status === "discarded";
      const orderEvents = (
        await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: order })
      ).events;
      const closing = orderEvents.findIndex((event) => event.type === "OrderArchived");
      const expected = orderEvents
        .slice(0, closing === -1 ? undefined : closing)
        .filter((event) => event.type === "OrderPaid")
        .map((event) => event.id);
      expect(
        [...expected].sort(),
        `${where}: ${order} the model tracked every payment it appended`,
      ).toEqual(
        (paid.get(order) as string[])
          .filter((id) => expected.includes(id) || closing === -1)
          .sort(),
      );
      const state = instance.state as LedgerState;
      if (abandoned) {
        expect(
          expected.slice(0, handled.length),
          `${where}: ${order} handled a prefix of its payments, once, in order`,
        ).toEqual(handled);
        const after = events.findIndex(
          (event) =>
            event.type === PROCESS_EVENTS.failed &&
            (event.payload as { letter?: { id: string } }).letter?.id ===
              instance.failure?.letter?.id,
        );
        expect(
          events.slice(after + 1).filter((event) => event.type !== PROCESS_EVENTS.eventParked)
            .length + 0,
          `${where}: ${order} ran nothing once given up`,
        ).toBe(0);
      } else {
        expect(instance.status, `${where}: ${order} settled`).toMatch(/^(started|completed)$/);
        expect(handled, `${where}: ${order} handled each payment once, in order`).toEqual(expected);
        expect(state.seen, `${where}: ${order} state saw every payment in order`).toEqual(expected);
      }
    }
    const letters = await harness.storage.deadLetterStore.list();
    for (const letter of letters) tally(`letter ${letter.status}`);
    expect(
      new Set(letters.map((letter) => letter.id)),
      `${where}: every letter records a failure and every failure has its letter`,
    ).toEqual(carried);
    expect(
      letters.filter((letter) => letter.status === "failed"),
      `${where}: no letter left failed`,
    ).toEqual([]);
    expect(
      letters
        .filter((letter) => letter.status === "discarded")
        .every((letter) => discarded.has(letter.id)),
      `${where}: only the letters discarded on purpose are discarded`,
    ).toBe(true);
  };
  try {
    await check();
  } catch (error) {
    throw new Error(
      `${where}\n${await summary()}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

describe("parked events under random interleavings", () => {
  it("never lose, reorder or double an event, and always settle with one letter per failure", async () => {
    const from = Number(process.env.FUZZ_FROM ?? 1);
    const to = Number(process.env.FUZZ_TO ?? 150);
    let ran = 0;
    for (let seed = from; seed <= to; seed += 1) {
      await run(seed);
      ran += 1;
    }
    expect(ran).toBe(to - from + 1);
    if (process.env.FUZZ_DEBUG !== undefined) {
      process.stderr.write(`ran ${ran} seeds ${JSON.stringify(Object.fromEntries(seen))}\n`);
    }
  }, 120_000);
});
