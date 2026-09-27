import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveConfig } from "../../config/schema.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { asInstant, type Instant } from "../../contracts/instant.ts";
import { memory } from "../../memory/index.ts";
import type { ProcessAfterFunction, ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { createApp } from "../app.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { DEADLINE_WAIT_ROUNDS } from "../scheduler/worker.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import {
  createRecordingLogger,
  type OrderProcessConfigArgs,
  orderAggregateEntry,
} from "../test-support.ts";
import { buildProcesses } from "./build-processes.ts";
import {
  afterFrom,
  deadlineFieldsOf,
  nextDeadline,
  processStateArgs,
  reachedKey,
} from "./deadlines.ts";
import { PROCESS_EVENTS } from "./lifecycle.ts";

interface RemindersState {
  readonly reminders: number;
  readonly nextReminder: Instant | null;
  readonly paymentDeadline: Instant | null;
  readonly paidAt: Instant | null;
}

interface Args {
  readonly state: RemindersState;
  readonly aggregateId: string;
  readonly event: { readonly timestamp: string };
  readonly after: ProcessAfterFunction;
  readonly idempotencyKey: string;
  readonly commands: Record<string, (payload: unknown) => Promise<unknown>>;
}

const calls: string[] = [];
const keys: string[] = [];
let placed: "both" | "tie" | "reminders" = "both";
let reminding: "ok" | "keep" | "flaky" | "conflict" | "hold" = "ok";
let failuresLeft = 0;
let paidFails = false;
let reminderLimit = 3;

const reset = (): void => {
  calls.length = 0;
  keys.length = 0;
  placed = "both";
  reminding = "ok";
  failuresLeft = 0;
  paidFails = false;
  reminderLimit = 3;
};

const registry: Registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      processes: {
        reminders: {
          module: {
            config: ({
              events,
            }: OrderProcessConfigArgs<"OrderPlaced" | "OrderPaid" | "OrderArchived">) => ({
              startedBy: [events.order.OrderPlaced],
              completedBy: [events.order.OrderArchived],
              timeout: "40d",
            }),
            state: ({ z, deadline, instant }: ProcessStateArgs) =>
              z.object({
                reminders: z.int().default(0),
                nextReminder: deadline(),
                paymentDeadline: deadline(),
                paidAt: instant(),
              }),
          },
          handlers: {
            order: {
              orderPlaced: {
                handler: ({ state, after }: Args) => ({
                  ...state,
                  nextReminder: after("24h"),
                  paymentDeadline:
                    placed === "both" ? after("72h") : placed === "tie" ? after("24h") : null,
                }),
              },
              orderPaid: {
                handler: ({ state, event }: Args) => {
                  if (paidFails) throw new Error("ledger is down");
                  return {
                    ...state,
                    paidAt: asInstant(event.timestamp),
                    nextReminder: null,
                    paymentDeadline: null,
                  };
                },
              },
            },
          },
          deadlines: {
            nextReminder: {
              handler: async ({ state, aggregateId, after, commands, idempotencyKey }: Args) => {
                calls.push(`reminder:${state.nextReminder}`);
                keys.push(idempotencyKey);
                if (reminding === "flaky" && failuresLeft > 0) {
                  failuresLeft -= 1;
                  throw new Error("mailer is down");
                }
                if (reminding === "conflict" && failuresLeft > 0) {
                  failuresLeft -= 1;
                  throw new ConcurrencyError({
                    streamId: "x",
                    expectedVersion: 1,
                    actualVersion: 2,
                  });
                }
                if (reminding === "keep") return state;
                await commands.touchOrder?.({ orderId: aggregateId });
                const reminders = state.reminders + 1;
                return {
                  ...state,
                  reminders,
                  nextReminder: reminders < reminderLimit ? after("24h") : null,
                };
              },
            },
            paymentDeadline: {
              handler: async ({ state, aggregateId, commands }: Args) => {
                calls.push(`payment:${state.paymentDeadline}`);
                await commands.archiveOrder?.({ orderId: aggregateId });
                return { ...state, paymentDeadline: null, nextReminder: null };
              },
            },
            timeout: {
              handler: ({ state }: Args) => {
                calls.push("timeout");
                return { ...state, reminders: -1 };
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms: number): string => new Date(t0 + ms).toISOString();
const stream = { aggregateType: "process:Reminders", aggregateId: "o-1" };

type Harness = Awaited<ReturnType<typeof createReactiveHarness>>;

const setUp = (config: object = {}): Promise<Harness> =>
  createReactiveHarness({ registry, config });

const settle = async (harness: Harness): Promise<void> => {
  for (;;) {
    await harness.dispatcher.processUntilIdle();
    if ((await harness.worker.runOnce()) === 0) return;
  }
};

const lifecycle = async (harness: Harness) =>
  (await harness.storage.eventStore.load(stream)).events;

const reachedOf = async (harness: Harness) =>
  (await lifecycle(harness))
    .filter((event) => event.type === PROCESS_EVENTS.deadlineReached)
    .map((event) => event.payload as { field: string; at: string; state: RemindersState });

describe("deadline helpers", () => {
  it("tells deadline fields from recorded moments and other fields", () => {
    const { deadline, instant } = processStateArgs;
    expect(
      deadlineFieldsOf(z.object({ b: deadline(), a: deadline(), paidAt: instant(), n: z.int() })),
    ).toEqual(["a", "b"]);
    expect(deadlineFieldsOf(z.object({ later: deadline().describe("wrapped") }))).toEqual([]);
    expect(deadlineFieldsOf(z.string())).toEqual([]);
    expect(z.object({ due: deadline(), paidAt: instant() }).parse({})).toEqual({
      due: null,
      paidAt: null,
    });
    expect(() => z.object({ due: deadline() }).parse({ due: "tomorrow" })).toThrow();
    expect(() =>
      z.object({ due: deadline() }).parse({ due: "2026-01-01T00:00:00+02:00" }),
    ).toThrow();
  });

  it("counts after() from its base, in any unit", () => {
    const later = afterFrom("2026-01-01T00:00:00.000Z");
    expect(later("24h")).toBe("2026-01-02T00:00:00.000Z");
    expect(later("90s")).toBe("2026-01-01T00:01:30.000Z");
    expect(later(250)).toBe("2026-01-01T00:00:00.250Z");
    expect(afterFrom("2026-01-01T00:00:00Z")("1d")).toBe("2026-01-02T00:00:00.000Z");
  });

  it("picks the earliest deadline not reached yet, the field name breaking a tie", () => {
    const state = { a: "2026-01-02T00:00:00.000Z", b: "2026-01-02T00:00:00Z", c: null, other: 1 };
    expect(
      nextDeadline({ fields: ["b", "a", "c"], state, timeoutAt: null, reached: new Set() }),
    ).toEqual({ field: "a", at: "2026-01-02T00:00:00.000Z" });
    expect(
      nextDeadline({
        fields: ["a", "b"],
        state,
        timeoutAt: "2026-01-01T12:00:00.000Z",
        reached: new Set(),
      }),
    ).toEqual({ field: "timeout", at: "2026-01-01T12:00:00.000Z" });
    const reached = new Set([reachedKey({ field: "a", at: "2026-01-02T00:00:00Z" })]);
    expect(nextDeadline({ fields: ["a", "b"], state, timeoutAt: null, reached })).toEqual({
      field: "b",
      at: "2026-01-02T00:00:00Z",
    });
    expect(nextDeadline({ fields: [], state: {}, timeoutAt: null, reached })).toBeNull();
  });

  it("turns dates and UTC strings into instants and refuses anything else", () => {
    expect(asInstant(new Date(t0))).toBe("2026-01-01T00:00:00.000Z");
    expect(asInstant("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
    expect(() => asInstant("2026-01-01")).toThrow(
      expect.objectContaining({
        message: 'Invalid instant: "2026-01-01"',
        issues: [
          {
            path: [],
            message: "Expected an ISO 8601 date and time in UTC, such as 2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(() => asInstant(new Date(Number.NaN))).toThrow(ValidationError);
  });
});

describe("process deadlines at boot", () => {
  const config = resolveConfig({ storage: memory() });
  const withProcess = (process: Registry["aggregates"][string]["processes"][string]): Registry => ({
    aggregates: { order: { ...orderAggregateEntry(), processes: { reminders: process } } },
    readModels: {},
  });
  const module = {
    config: () => ({ startedBy: ["order.OrderPlaced"] }),
    state: ({ z, deadline }: ProcessStateArgs) => z.object({ nextReminder: deadline() }),
  };

  it("compiles the deadline fields and their handlers, timeout included", () => {
    const [process] = buildProcesses({ registry, config }).all;
    expect(process?.deadlineFields).toEqual(["nextReminder", "paymentDeadline"]);
    expect(Object.keys(process?.deadlineHandlers ?? {}).sort()).toEqual([
      "nextReminder",
      "paymentDeadline",
      "timeout",
    ]);
  });

  it("names the file a deadline lacks, and the field a handler has no deadline for", () => {
    expect(() =>
      buildProcesses({ registry: withProcess({ module, handlers: {} }), config }),
    ).toThrow(
      'aggregates.order.processes.reminders: the deadline "nextReminder" has no handler; add at-next-reminder.ts to the process',
    );
    expect(() =>
      buildProcesses({
        registry: withProcess({
          module,
          handlers: {},
          deadlines: {
            nextReminder: { handler: () => undefined },
            paidAt: { handler: () => undefined },
          },
        }),
        config,
      }),
    ).toThrow(
      'aggregates.order.processes.reminders: at-paid-at.ts handles "paidAt", which the state does not declare with deadline()',
    );
  });

  it("keeps the name timeout for config.timeout", () => {
    expect(() =>
      buildProcesses({
        registry: withProcess({
          module: {
            config: module.config,
            state: ({ z, deadline }: ProcessStateArgs) => z.object({ timeout: deadline() }),
          },
          handlers: {},
          deadlines: { timeout: { handler: () => undefined } },
        }),
        config,
      }),
    ).toThrow('the deadline "timeout" is reserved for config.timeout');
  });
});

describe("process deadlines", () => {
  it("are scheduled, moved and cancelled through the state, and none runs once the process ends", async () => {
    reset();
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    expect(await harness.storage.scheduler.list()).toMatchObject([
      {
        dedupeKey: "process-deadline:order.reminders:o-1",
        executeAt: at(DAY),
        command: { payload: { field: "nextReminder", at: at(DAY) } },
        context: { causationId: "process:Reminders:o-1", depth: 0 },
      },
    ]);
    await harness.processes.handleDeadline({
      payload: { process: "order.reminders", aggregateId: "o-1" },
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });
    expect(calls).toEqual([]);

    harness.clock.advance(DAY);
    await settle(harness);
    expect(calls).toEqual([`reminder:${at(DAY)}`]);
    expect(await reachedOf(harness)).toEqual([
      {
        field: "nextReminder",
        at: at(DAY),
        state: {
          reminders: 1,
          nextReminder: at(2 * DAY),
          paymentDeadline: at(3 * DAY),
          paidAt: null,
        },
      },
    ]);
    expect(await harness.storage.scheduler.list()).toMatchObject([{ executeAt: at(2 * DAY) }]);

    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await settle(harness);
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { executeAt: at(40 * DAY), command: { payload: { field: "timeout" } } },
    ]);

    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await settle(harness);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    harness.clock.advance(100 * DAY);
    await settle(harness);
    expect(calls).toEqual([`reminder:${at(DAY)}`]);
    expect((await lifecycle(harness)).at(-1)?.type).toBe(PROCESS_EVENTS.completed);
  });

  it("reach each deadline once per moment, earliest first, the field name breaking a tie", async () => {
    reset();
    placed = "tie";
    reminderLimit = 1;
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    harness.clock.advance(DAY);
    await settle(harness);
    expect(calls).toEqual([`reminder:${at(DAY)}`, `payment:${at(DAY)}`]);
    expect((await reachedOf(harness)).map(({ field, at }) => `${field}@${at}`)).toEqual([
      `nextReminder@${at(DAY)}`,
      `paymentDeadline@${at(DAY)}`,
    ]);
    expect((await lifecycle(harness)).at(-1)?.type).toBe(PROCESS_EVENTS.completed);
  });

  it("count after() from what triggered them, so a chain catches up in order after an outage", async () => {
    reset();
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    harness.clock.advance(2 * DAY + HOUR);
    await settle(harness);
    expect(calls).toEqual([`reminder:${at(DAY)}`, `reminder:${at(2 * DAY)}`]);
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { executeAt: at(3 * DAY), command: { payload: { field: "nextReminder" } } },
    ]);
    harness.clock.advance(DAY);
    await settle(harness);
    expect(calls).toEqual([
      `reminder:${at(DAY)}`,
      `reminder:${at(2 * DAY)}`,
      `reminder:${at(3 * DAY)}`,
      `payment:${at(3 * DAY)}`,
    ]);
  });

  it("fail for good when a handler leaves its deadline at the moment that came due, and replay with a new key", async () => {
    reset();
    reminding = "keep";
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    harness.clock.advance(DAY);
    await settle(harness);
    expect((await lifecycle(harness)).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.failed,
    ]);
    expect((await lifecycle(harness)).at(-1)?.payload).toEqual({
      deadline: "nextReminder",
      error: 'Process order.reminders left the deadline "nextReminder" at the moment that came due',
    });
    expect(await harness.storage.scheduler.list()).toEqual([]);
    await expect(
      harness.processes.handleDeadline({
        payload: { process: "order.reminders", aggregateId: "o-1" },
        context: { correlationId: "c", causationId: "c", depth: 0 },
        replay: "r",
      }),
    ).rejects.toMatchObject({
      issues: [
        { path: ["nextReminder"], message: "Set it to null, or to another moment with after()" },
      ],
    });
    const [letter] = await harness.storage.deadLetterStore.list();
    expect(letter).toMatchObject({
      kind: "process",
      eventId: "deadline:nextReminder",
      errorType: "terminal",
      errorMessage:
        'Process order.reminders left the deadline "nextReminder" at the moment that came due',
    });

    reminding = "ok";
    const deadLetters = (await import("../dead-letters/dead-letters.ts")).createDeadLetters({
      storage: harness.storage,
      pipeline: harness.pipeline,
      policies: harness.policies,
      policyExecutor: harness.policyExecutor,
      processes: harness.processes,
      ids: harness.ids,
      clock: harness.clock,
      logger: harness.logger,
    });
    await deadLetters.replay(letter?.id ?? "");
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(
      deriveIdempotencyKey({
        kind: "process",
        handler: "order.reminders",
        subject: `o-1:deadline:nextReminder:${at(DAY)}`,
      }),
    );
    expect(new Set(keys).size).toBe(3);
    expect((await lifecycle(harness)).at(-1)?.type).toBe(PROCESS_EVENTS.deadlineReached);
    expect(await harness.storage.scheduler.list()).toMatchObject([{ executeAt: at(2 * DAY) }]);
  });

  it("retry with back-off without moving the deadline or its key", async () => {
    reset();
    reminding = "flaky";
    failuresLeft = 2;
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    harness.clock.advance(DAY);
    await settle(harness);
    expect(await harness.storage.scheduler.list()).toMatchObject([{ attempts: 1 }]);
    harness.clock.advance(HOUR);
    await settle(harness);
    await settle(harness);
    harness.clock.advance(HOUR);
    await settle(harness);
    expect(calls).toEqual([`reminder:${at(DAY)}`, `reminder:${at(DAY)}`, `reminder:${at(DAY)}`]);
    expect(new Set(keys).size).toBe(1);
    expect(await reachedOf(harness)).toMatchObject([
      { at: at(DAY), state: { nextReminder: at(2 * DAY) } },
    ]);
  });

  it("dead-letter a deadline whose retries run out and fail the process", async () => {
    reset();
    reminding = "flaky";
    failuresLeft = 99;
    const harness = await setUp({
      runtime: {
        overrides: {
          order: { processes: { retry: { strategy: "fixed", maxAttempts: 2, baseDelay: 1_000 } } },
        },
      },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    harness.clock.advance(DAY);
    await settle(harness);
    harness.clock.advance(1_000);
    await settle(harness);
    expect(calls).toHaveLength(2);
    expect((await lifecycle(harness)).at(-1)?.type).toBe(PROCESS_EVENTS.failed);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { eventId: "deadline:nextReminder", errorType: "retriable_exhausted", attempts: 2 },
    ]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });

  it("go back to the schedule without counting an attempt when the instance moved", async () => {
    reset();
    reminding = "conflict";
    failuresLeft = 1;
    const harness = await setUp({
      runtime: { processes: { retry: { strategy: "none" } } },
    });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    harness.clock.advance(DAY);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { executeAt: at(DAY), attempts: 0 },
    ]);
    await settle(harness);
    expect(calls).toEqual([`reminder:${at(DAY)}`, `reminder:${at(DAY)}`]);
    expect(await harness.storage.deadLetterStore.list()).toEqual([]);
  });

  it("put the entry back on the next delivery after a crash between the append and the schedule", async () => {
    reset();
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    await harness.storage.scheduler.cancel("process-deadline:order.reminders:o-1");
    await harness.storage.checkpointStore.set("processes", 0);
    await settle(harness);
    expect(await harness.storage.scheduler.list()).toMatchObject([{ executeAt: at(DAY) }]);
    expect((await lifecycle(harness)).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
    ]);
  });

  it("wait for the process runner to handle the events stored before them", async () => {
    reset();
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    harness.clock.advance(DAY);
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    expect(await harness.worker.runOnce()).toBe(1);
    expect(harness.worker.waitingDeadlines()).toBe(1);
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { executeAt: at(DAY), attempts: 0 },
    ]);
    await settle(harness);
    expect(calls).toEqual([]);
    expect(harness.worker.waitingDeadlines()).toBe(0);
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { command: { payload: { field: "timeout" } } },
    ]);
  });

  it("run anyway once the wait runs out", async () => {
    reset();
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    harness.clock.advance(DAY);
    await harness.pipeline.dispatch({ type: "TouchOrder", payload: { orderId: "o-1" } });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-2", total: 10 } });
    for (let round = 0; round < DEADLINE_WAIT_ROUNDS; round += 1) await harness.worker.runOnce();
    expect(calls).toEqual([]);
    await harness.worker.runOnce();
    expect(calls).toEqual([`reminder:${at(DAY)}`]);
    expect(harness.worker.waitingDeadlines()).toBe(0);
  });

  it("end the process as timed out at config.timeout, keeping the state the handler returned", async () => {
    reset();
    placed = "reminders";
    reminderLimit = 1;
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    harness.clock.advance(40 * DAY);
    await settle(harness);
    expect(calls).toEqual([`reminder:${at(DAY)}`, "timeout"]);
    const events = await lifecycle(harness);
    expect(events.at(-1)).toMatchObject({
      type: PROCESS_EVENTS.timedOut,
      payload: {
        state: { reminders: -1, nextReminder: null, paymentDeadline: null, paidAt: null },
      },
    });
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });

  it("write the entry again when the instance moved while it was being written", async () => {
    reset();
    const harness = await setUp();
    const schedule = harness.storage.scheduler.schedule;
    let raced = false;
    harness.storage.scheduler.schedule = async (args) => {
      await schedule(args);
      if (raced) return;
      raced = true;
      const { events } = await harness.storage.eventStore.load(stream);
      await harness.storage.eventStore.append({
        ...stream,
        expectedVersion: events.length,
        events: [
          {
            id: "concurrent",
            ...stream,
            version: events.length + 1,
            type: PROCESS_EVENTS.handled,
            payload: {
              state: { reminders: 0, nextReminder: at(HOUR), paymentDeadline: null, paidAt: null },
            },
            timestamp: at(0),
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
    };
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.dispatcher.processUntilIdle();
    expect(await harness.storage.scheduler.list()).toMatchObject([{ executeAt: at(HOUR) }]);
  });

  it("run delayed commands at once beside deadlines that wait, and forget a wait whose entry moved", async () => {
    reset();
    const harness = await setUp();
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
      options: { delay: "24h" },
    });
    await harness.pipeline.dispatch({ type: "TouchOrder", payload: { orderId: "o-1" } });
    harness.clock.advance(DAY);
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-2", total: 10 } });
    expect(await harness.worker.runOnce()).toBe(2);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(order.events.map((event) => event.type)).toContain("OrderPaid");
    expect(calls).toEqual([]);
    expect(harness.worker.waitingDeadlines()).toBe(1);

    await harness.dispatcher.processUntilIdle();
    await harness.pipeline.dispatch({
      type: "TouchOrder",
      payload: { orderId: "o-2" },
      options: { delay: "1s" },
    });
    harness.clock.advance(1_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(harness.worker.waitingDeadlines()).toBe(0);
    expect(calls).toEqual([]);
  });

  it("end the process as timed out with its state when there is no at-timeout.ts", async () => {
    const quiet: Registry = {
      aggregates: {
        order: {
          ...orderAggregateEntry(),
          processes: {
            quiet: {
              module: {
                config: () => ({ startedBy: ["order.OrderPlaced"], timeout: "1h" }),
                state: ({ z }: ProcessStateArgs) => z.object({ step: z.int().default(3) }),
              },
              handlers: {},
            },
          },
        },
      },
      readModels: {},
    };
    const harness = await createReactiveHarness({ registry: quiet });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    harness.clock.advance(HOUR);
    await settle(harness);
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "process:Quiet",
      aggregateId: "o-1",
    });
    expect(events.at(-1)).toMatchObject({
      type: PROCESS_EVENTS.timedOut,
      payload: { state: { step: 3 } },
    });
  });

  it("keep a daily chain going for a month past maxChainDepth", async () => {
    reset();
    placed = "reminders";
    reminderLimit = 30;
    const harness = await setUp({ runtime: { policies: { maxChainDepth: 2 } } });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await settle(harness);
    for (let day = 0; day < 30; day += 1) {
      harness.clock.advance(DAY);
      await settle(harness);
    }
    expect(calls).toHaveLength(30);
    expect(await harness.storage.deadLetterStore.list()).toEqual([]);
    const reached = await reachedOf(harness);
    expect(reached.at(-1)).toMatchObject({
      at: at(30 * DAY),
      state: { reminders: 30, nextReminder: null },
    });
  });
});

describe("a deadline that gives up with nothing pending", () => {
  it("fails no process and records nothing but a warning", async () => {
    reset();
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({ registry, logger });
    const failure = { error: new Error("gone"), attempts: 3, errorType: "terminal" as const };
    await harness.processes.failDeadline({
      payload: { process: "order.nope", aggregateId: "o-1" },
      ...failure,
    });
    await harness.processes.failDeadline({
      payload: { process: "order.reminders", aggregateId: "o-1" },
      ...failure,
    });
    expect(await lifecycle(harness)).toEqual([]);
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await settle(harness);
    await harness.processes.failDeadline({
      payload: { process: "order.reminders", aggregateId: "o-1" },
      ...failure,
    });
    expect((await lifecycle(harness)).at(-1)?.type).toBe(PROCESS_EVENTS.completed);
    expect(await harness.storage.deadLetterStore.list()).toEqual([]);
    expect(entries).toContainEqual({
      level: "warn",
      message: "process deadline gave up with no deadline pending",
      fields: { process: "order.reminders", aggregateId: "o-1", error: "gone" },
    });
  });
});

describe("process deadlines in an app", () => {
  const startApp = async () => {
    const clock = createFixedClock();
    const app = await createApp({
      registry,
      config: { storage: memory(), commands: { placeOrder: { notifier: { use: "memory" } } } },
      ids: createSequentialIdGenerator(),
      clock,
    });
    return { app, clock };
  };

  it("come due with one clock advance and one processUntilIdle", async () => {
    reset();
    const { app, clock } = await startApp();
    await app.commands.placeOrder?.({ orderId: "o-1", total: 10 });
    await app.processUntilIdle();
    expect(await app.nextDueAt()).toEqual(new Date(at(DAY)));
    clock.advance(3 * DAY);
    expect(await app.processUntilIdle()).toEqual({ idle: true });
    expect(calls).toEqual([
      `reminder:${at(DAY)}`,
      `reminder:${at(2 * DAY)}`,
      `reminder:${at(3 * DAY)}`,
      `payment:${at(3 * DAY)}`,
    ]);
    expect(await app.nextDueAt()).toBeNull();
  });

  it("show in getLag while they wait for a process runner held by a failing handler", async () => {
    reset();
    const { app, clock } = await startApp();
    await app.commands.placeOrder?.({ orderId: "o-1", total: 10 });
    await app.processUntilIdle();
    paidFails = true;
    await app.commands.payOrder?.({ orderId: "o-1", method: "card" });
    clock.advance(DAY);
    await app.processUntilIdle({ maxPasses: 1 });
    expect((await app.getLag()).waitingDeadlines).toBe(1);
    expect(calls).toEqual([]);
    expect(await app.processUntilIdle()).toEqual({ idle: true });
    expect(calls).toEqual([`reminder:${at(DAY)}`]);
    expect((await app.getLag()).waitingDeadlines).toBe(0);
    await app.stop();
  });
});
