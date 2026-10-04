import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import { asDuration } from "../../contracts/duration.ts";
import { DeadLetterSettledError, DomainError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createDeadLetters } from "../dead-letters/dead-letters.ts";
import { type CreateReactiveHarnessArgs, createReactiveHarness } from "../reactive-harness.ts";
import {
  createRecordingLogger,
  type OrderProcessConfigArgs,
  orderAggregateEntry,
} from "../test-support.ts";
import { PROCESS_DEADLINE_COMMAND } from "./deadlines.ts";
import { PROCESS_EVENTS } from "./lifecycle.ts";

interface HandlerArgs {
  readonly state: { archived: number };
  readonly aggregateId: string;
  readonly commands: Record<
    string,
    (payload: unknown, options?: { readonly delay?: unknown }) => Promise<unknown>
  >;
}

const calls: string[] = [];
let archiving: "ok" | "domain" | "flaky" = "ok";
let flakyFailures = 0;
let targets: (aggregateId: string) => readonly string[] = (aggregateId) => [aggregateId];
let delayed = false;
let beforeArchive: (() => Promise<void>) | undefined;
let timeoutFails = false;
let awaiting = true;
let placing = false;
let paying: "ok" | "domain" = "ok";

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
              completedBy: [events.order.OrderArchived],
              timeout: "48h",
            }),
            state: ({ z }: PayloadArgs) => z.object({ archived: z.int().default(0) }),
          },
          handlers: {
            order: {
              orderArchived: {
                handler: async ({ state, aggregateId }: HandlerArgs) => {
                  calls.push(`archived:${aggregateId}`);
                  await beforeArchive?.();
                  if (archiving === "domain") throw new DomainError("cannot compensate");
                  if (archiving === "flaky" && flakyFailures > 0) {
                    flakyFailures -= 1;
                    throw new Error("network");
                  }
                  return { archived: state.archived + 1 };
                },
              },
              orderPaid: {
                handler: ({ aggregateId }: HandlerArgs) => {
                  calls.push(`paid:${aggregateId}`);
                  if (paying === "domain") throw new DomainError("cannot take payment");
                },
              },
            },
          },
          deadlines: {
            timeout: {
              handler: async ({ aggregateId, commands }: HandlerArgs) => {
                calls.push(`timeout:${aggregateId}`);
                if (timeoutFails) throw new DomainError("not yet");
                if (placing) await commands.placeOrder?.({ orderId: "o-3", total: 1 });
                for (const orderId of targets(aggregateId)) {
                  const archived = commands.archiveOrder?.(
                    { orderId },
                    delayed ? { delay: asDuration("1h") } : undefined,
                  );
                  if (awaiting) await archived;
                }
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
};

const adapters: readonly [string, () => Adapter][] = [
  ["memory", () => memory()],
  ["SQLite (node:sqlite)", () => createNodeSqliteAdapter().adapter],
];

// The same process, with a handler for the event that starts it.
const withStartHandler = (): Registry => {
  const order = registry.aggregates.order as NonNullable<Registry["aggregates"][string]>;
  const process = order.processes.orderPayment as NonNullable<(typeof order.processes)[string]>;
  return {
    ...registry,
    aggregates: {
      order: {
        ...order,
        processes: {
          orderPayment: {
            ...process,
            handlers: {
              order: { ...process.handlers.order, orderPlaced: { handler: () => undefined } },
            },
          },
        },
      },
    },
  };
};

const setUp = async (
  adapter: () => Adapter,
  config: CreateReactiveHarnessArgs["config"] = {},
  app: Registry = registry,
) => {
  calls.length = 0;
  archiving = "ok";
  flakyFailures = 0;
  targets = (aggregateId) => [aggregateId];
  delayed = false;
  beforeArchive = undefined;
  timeoutFails = false;
  awaiting = true;
  placing = false;
  paying = "ok";
  const harness = await createReactiveHarness({ registry: app, config, adapter: adapter() });
  const deadLetters = createDeadLetters({
    storage: harness.storage,
    pipeline: harness.pipeline,
    policies: harness.policies,
    policyExecutor: harness.policyExecutor,
    processes: harness.processes,
    config: harness.config,
    ids: harness.ids,
    clock: harness.clock,
    logger: harness.logger,
  });
  const place = (orderId: string) =>
    harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId, total: 10 } });
  const timeOut = async () => {
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(172_800_000);
    await harness.worker.runOnce();
  };
  const stream = async (id = "o-1") =>
    (
      await harness.storage.eventStore.load({
        aggregateType: "process:OrderPayment",
        aggregateId: id,
      })
    ).events;
  const archivedOf = async (id = "o-1") => {
    const { events } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: id,
    });
    return events.find((event) => event.type === "OrderArchived");
  };
  const types = async (id = "o-1") => (await stream(id)).map((event) => event.type);
  // A follow-up that fails for good, and the letter it leaves; the next run succeeds.
  const failFollowUp = async () => {
    archiving = "domain";
    await place("o-1");
    await timeOut();
    await harness.dispatcher.runUntilIdle();
    archiving = "ok";
    const [letter] = await deadLetters.list();
    if (letter === undefined) throw new Error("no letter");
    return letter;
  };
  return { harness, deadLetters, place, timeOut, stream, types, archivedOf, failFollowUp };
};

describe.each(adapters)("the follow-ups of a process that timed out, on %s", (_name, adapter) => {
  it("hands the events its at-timeout causes for the instance to their handlers after it ends", async () => {
    const { harness, place, timeOut, stream, archivedOf } = await setUp(adapter);
    await place("o-1");
    await timeOut();
    const archived = await archivedOf();
    expect((await stream()).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
    ]);
    expect((await stream())[1]?.payload).toEqual({
      state: { archived: 0 },
      followUps: [archived?.id],
    });

    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["timeout:o-1", "archived:o-1"]);
    const events = await stream();
    expect(events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
      PROCESS_EVENTS.handled,
    ]);
    expect(events[2]?.payload).toMatchObject({ state: { archived: 1 }, eventId: archived?.id });
    expect(
      await harness.storage.inboxLedger.get({
        subscriber: "order.orderPayment",
        eventId: archived?.id ?? "",
      }),
    ).toMatchObject({ status: "succeeded" });
    expect(await harness.storage.scheduler.list()).toEqual([]);

    await harness.dispatcher.runUntilIdle();
    expect(await stream()).toHaveLength(3);
  });

  it("still drops every other event once the instance timed out", async () => {
    const { harness, place, timeOut, stream } = await setUp(adapter);
    targets = () => [];
    await place("o-1");
    await timeOut();
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["timeout:o-1"]);
    expect((await stream()).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
    ]);
    expect((await stream())[1]?.payload).toEqual({ state: { archived: 0 } });
  });

  it("records a follow-up routed to another instance, which handles it as any event", async () => {
    const { harness, place, stream, archivedOf } = await setUp(adapter);
    targets = () => ["o-2"];
    await place("o-1");
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(86_400_000);
    await place("o-2");
    await harness.dispatcher.runUntilIdle();
    harness.clock.advance(86_400_000);
    await harness.worker.runOnce();
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["timeout:o-1", "archived:o-2"]);
    const timedOut = await stream("o-1");
    expect(timedOut.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
    ]);
    expect(timedOut[1]?.payload).toMatchObject({ followUps: [(await archivedOf("o-2"))?.id] });
    expect((await stream("o-2")).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.completed,
    ]);
  });

  it("does not wait for a command the timeout delays", async () => {
    const { harness, place, timeOut, stream } = await setUp(adapter);
    delayed = true;
    await place("o-1");
    await timeOut();
    expect((await stream())[1]?.payload).toEqual({ state: { archived: 0 } });
    harness.clock.advance(3_600_000);
    await harness.worker.runOnce();
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["timeout:o-1"]);
  });

  it("retries a follow-up that fails through the inbox, as any event", async () => {
    const { harness, place, timeOut, stream } = await setUp(adapter, {
      runtime: { processes: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "1s" } } },
    });
    archiving = "flaky";
    flakyFailures = 1;
    await place("o-1");
    await timeOut();
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["timeout:o-1", "archived:o-1"]);
    harness.clock.advance(1_000);
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["timeout:o-1", "archived:o-1", "archived:o-1"]);
    expect((await stream()).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
      PROCESS_EVENTS.handled,
    ]);
  });

  it("files a letter without failing the ended instance, and replays it in its own transaction", async () => {
    const { harness, deadLetters, place, timeOut, stream } = await setUp(adapter);
    archiving = "domain";
    await place("o-1");
    await timeOut();
    await harness.dispatcher.runUntilIdle();
    expect((await stream()).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
    ]);
    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({
      kind: "process",
      subscriber: "order.orderPayment",
      eventType: "OrderArchived",
      parked: 0,
    });

    archiving = "ok";
    expect(await deadLetters.replay(letter?.id ?? "")).toMatchObject({
      status: "replayed",
      parked: 0,
    });
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("replayed");
    expect(calls).toEqual(["timeout:o-1", "archived:o-1", "archived:o-1"]);
    expect((await stream()).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
      PROCESS_EVENTS.handled,
    ]);
  });

  it("writes nothing for a follow-up letter whose discard won the race", async () => {
    const { harness, deadLetters, place, timeOut, stream } = await setUp(adapter);
    archiving = "domain";
    await place("o-1");
    await timeOut();
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    archiving = "ok";
    beforeArchive = async () => {
      beforeArchive = undefined;
      await deadLetters.discard(letter?.id ?? "");
    };
    await expect(deadLetters.replay(letter?.id ?? "")).rejects.toThrow(DeadLetterSettledError);
    expect((await stream()).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
    ]);
    expect((await deadLetters.get(letter?.id ?? ""))?.status).toBe("discarded");
  });

  it("keeps the follow-ups of a timeout replayed from its letter", async () => {
    const { harness, deadLetters, place, timeOut, stream } = await setUp(adapter);
    timeoutFails = true;
    await place("o-1");
    await timeOut();
    const [letter] = await deadLetters.list();
    expect(letter).toMatchObject({ kind: "process", eventType: PROCESS_DEADLINE_COMMAND });
    timeoutFails = false;
    await deadLetters.replay(letter?.id ?? "");
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["timeout:o-1", "timeout:o-1", "archived:o-1"]);
    expect((await stream()).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.failed,
      PROCESS_EVENTS.timedOut,
      PROCESS_EVENTS.handled,
    ]);
  });

  it("writes nothing when a follow-up letter is replayed after the event was handled", async () => {
    const { harness, deadLetters, place, timeOut, stream, archivedOf } = await setUp(adapter);
    archiving = "domain";
    await place("o-1");
    await timeOut();
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    archiving = "ok";
    await deadLetters.replay(letter?.id ?? "");
    const archived = await archivedOf();
    await harness.processes.replay({
      process: "order.orderPayment",
      event: archived as NonNullable<typeof archived>,
      replay: "again",
    });
    expect(await stream()).toHaveLength(3);
  });

  it("waits for the commands the timeout did not await", async () => {
    const { harness, place, timeOut, types } = await setUp(adapter);
    awaiting = false;
    await place("o-1");
    await timeOut();
    await harness.dispatcher.runUntilIdle();
    expect(calls).toEqual(["timeout:o-1", "archived:o-1"]);
    expect(await types()).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
      PROCESS_EVENTS.handled,
    ]);
  });

  it("leaves out an event that starts the process, whose handler would start it again", async () => {
    const { harness, place, timeOut, stream, archivedOf } = await setUp(
      adapter,
      {},
      withStartHandler(),
    );
    placing = true;
    await place("o-1");
    await timeOut();
    expect((await stream())[2]?.payload).toEqual({
      state: { archived: 0 },
      followUps: [(await archivedOf())?.id],
    });
    await harness.dispatcher.runUntilIdle();
    expect(await stream("o-3")).toHaveLength(2);
  });

  it("runs nothing when the letter of a follow-up is settled before a rerun", async () => {
    const { harness, deadLetters, types, failFollowUp } = await setUp(adapter);
    const letter = await failFollowUp();
    beforeArchive = async () => {
      beforeArchive = undefined;
      await deadLetters.discard(letter.id);
      const { version } = await harness.storage.eventStore.load({
        aggregateType: "process:OrderPayment",
        aggregateId: "o-1",
      });
      await harness.storage.eventStore.append({
        aggregateType: "process:OrderPayment",
        aggregateId: "o-1",
        expectedVersion: version,
        events: [
          {
            id: "moved",
            aggregateType: "process:OrderPayment",
            aggregateId: "o-1",
            version: version + 1,
            type: PROCESS_EVENTS.resumed,
            payload: {},
            timestamp: harness.clock.now().toISOString(),
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
    await expect(deadLetters.replay(letter.id)).rejects.toThrow(DeadLetterSettledError);
    expect(calls).toEqual(["timeout:o-1", "archived:o-1", "archived:o-1"]);
    expect(await types()).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
      PROCESS_EVENTS.resumed,
    ]);
  });

  it("lets a follow-up through on replay once a deploy removed its handler", async () => {
    const { harness, archivedOf, failFollowUp } = await setUp(adapter);
    await failFollowUp();
    const order = registry.aggregates.order as NonNullable<Registry["aggregates"][string]>;
    const process = order.processes.orderPayment as NonNullable<(typeof order.processes)[string]>;
    const { orderArchived: _removed, ...kept } = process.handlers.order ?? {};
    const letThrough = createRecordingLogger();
    const deployed = await createReactiveHarness({
      registry: {
        aggregates: {
          order: {
            ...order,
            processes: { orderPayment: { ...process, handlers: { order: kept } } },
          },
        },
        readModels: {},
      },
      logger: letThrough.logger,
      adapter: adapter(),
    });
    for (const aggregateType of ["order", "process:OrderPayment"]) {
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
    const archived = await archivedOf();
    if (archived === undefined) throw new Error("not archived");
    expect(
      await deployed.processes.replay({
        process: "order.orderPayment",
        event: archived,
        replay: "r",
      }),
    ).toBe(false);
    const { events } = await deployed.storage.eventStore.load({
      aggregateType: "process:OrderPayment",
      aggregateId: "o-1",
    });
    expect(events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.timedOut,
      PROCESS_EVENTS.handled,
    ]);
    expect(letThrough.entries).toContainEqual({
      level: "warn",
      message: "process no longer acts on an event it waited for; it is let through",
      fields: { process: "order.orderPayment", aggregateId: "o-1", eventId: archived.id },
    });
  });

  it("keeps the follow-ups of a timeout that comes due while a replay drains", async () => {
    const { harness, deadLetters, place, stream, archivedOf } = await setUp(adapter);
    paying = "domain";
    await place("o-1");
    await harness.pipeline.dispatch({
      type: "PayOrder",
      payload: { orderId: "o-1", method: "card" },
    });
    await harness.dispatcher.runUntilIdle();
    const [letter] = await deadLetters.list();
    harness.clock.advance(172_800_000);
    await harness.worker.runOnce();
    await harness.pipeline.dispatch({ type: "ArchiveOrder", payload: { orderId: "o-1" } });
    await harness.dispatcher.runUntilIdle();
    paying = "ok";
    await deadLetters.replay(letter?.id ?? "");
    await harness.dispatcher.runUntilIdle();
    const events = await stream();
    const timedOut = events.find((event) => event.type === PROCESS_EVENTS.timedOut);
    const { events: order } = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    const followUp = order.filter((event) => event.type === "OrderArchived").at(-1);
    expect(timedOut?.payload).toMatchObject({ followUps: [followUp?.id] });
    expect(events.at(-1)).toMatchObject({
      type: PROCESS_EVENTS.handled,
      payload: { eventId: followUp?.id },
    });
    expect(followUp?.id).not.toBe((await archivedOf())?.id);
  });
});
