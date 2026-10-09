import { describe, expect, it } from "vitest";
import type { Adapter, StoragePorts, StorageTransaction } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import type { RetryConfig } from "../../config/types.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { ProcessAfterFunction, ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { PROCESS_EVENTS } from "../process/lifecycle.ts";
import { createReactiveHarness, type ReactiveHarness } from "../reactive-harness.ts";
import {
  breakNextCommit,
  type OrderProcessConfigArgs,
  orderAggregateEntry,
} from "../test-support.ts";
import {
  CommitFailed,
  commitAttempt,
  commitWork,
  createUnitOfWork,
  type UnitOfWork,
} from "./unit-of-work.ts";

interface Commands {
  readonly [name: string]: (
    payload: unknown,
    options?: object,
  ) => Promise<{
    readonly rejected: string | false;
    readonly version?: number;
    readonly eventTypes?: readonly string[];
  }>;
}

interface PolicyArgs {
  readonly event: { readonly aggregateId: string };
  readonly commands: Commands;
  readonly idempotencyKey: string;
}

type Mode = "ok" | "refuse" | "compensate";
let mode: Mode = "ok";
const providerCalls: string[] = [];
const seen: unknown[] = [];

const reset = (next: Mode): void => {
  mode = next;
  providerCalls.length = 0;
  seen.length = 0;
};

// A policy that calls a provider, pays the order at once, archives it later and, when asked,
// refuses after both, or pays twice and compensates the refusal.
const policyRegistry: Registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      policies: {
        settleOnOrderPlaced: {
          module: {
            handler: async ({ event, commands, idempotencyKey }: PolicyArgs) => {
              providerCalls.push(idempotencyKey);
              const orderId = event.aggregateId;
              seen.push(await commands.payOrder?.({ orderId, method: "card" }));
              await commands.archiveOrder?.({ orderId }, { delay: "1h" });
              if (mode === "refuse") throw new ValidationError("provider refused", []);
              if (mode === "compensate") {
                const again = await commands.payOrder?.({ orderId, method: "card" });
                seen.push(again);
                if (again?.rejected === "NotPlaced") await commands.touchOrder?.({ orderId });
              }
            },
          },
        },
      },
    },
  },
  readModels: {},
};

// A process that does the same on its starting event, and sets a deadline.
const processRegistry: Registry = {
  aggregates: {
    order: {
      ...orderAggregateEntry(),
      processes: {
        settlement: {
          module: {
            config: ({ events }: OrderProcessConfigArgs<"OrderPlaced" | "OrderArchived">) => ({
              startedBy: [events.order.OrderPlaced],
              completedBy: [events.order.OrderArchived],
              timeout: "30d",
            }),
            state: ({ z, deadline }: ProcessStateArgs) => z.object({ remind: deadline() }),
          },
          handlers: {
            order: {
              orderPlaced: {
                handler: async ({
                  event,
                  commands,
                  idempotencyKey,
                  after,
                  state,
                }: PolicyArgs & {
                  readonly after: ProcessAfterFunction;
                  readonly state: object;
                }) => {
                  providerCalls.push(idempotencyKey);
                  const orderId = event.aggregateId;
                  seen.push(await commands.payOrder?.({ orderId, method: "card" }));
                  await commands.archiveOrder?.({ orderId }, { delay: "1h" });
                  if (mode === "refuse") throw new ValidationError("provider refused", []);
                  return { ...state, remind: after("1d") };
                },
              },
            },
          },
          deadlines: { remind: { handler: ({ state }: { readonly state: object }) => state } },
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

const orderTypes = async (harness: ReactiveHarness) =>
  (
    await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
  ).events.map((event) => event.type);
const scheduledTypes = async (harness: ReactiveHarness) =>
  (await harness.storage.scheduler.list()).map((entry) => entry.command.type);
const claimOf = async (harness: ReactiveHarness, handler: string) => {
  const [placed] = (
    await harness.storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" })
  ).events;
  return harness.storage.inboxLedger.get({ handler, eventId: placed?.id ?? "" });
};
const place = (harness: ReactiveHarness) =>
  harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
const settle = async (harness: ReactiveHarness) => {
  await harness.dispatcher.runUntilIdle();
  await harness.worker.runOnce();
};
const pastPolicyLease = (harness: ReactiveHarness) =>
  harness.clock.advance(harness.config.runtime.policies.timeoutMs * 2 + 1);
const pastProcessLease = (harness: ReactiveHarness) =>
  harness.clock.advance(harness.config.runtime.processes.handlerTimeoutMs * 2 + 1);
const processTypes = async (harness: ReactiveHarness) =>
  (
    await harness.storage.eventStore.load({
      aggregateType: "process:order.settlement",
      aggregateId: "o-1",
    })
  ).events.map((event) => event.type);

// Breaks the claim's completion inside the next transaction that completes one.
const breakNextCompletion = (storage: StoragePorts): { readonly broke: () => boolean } => {
  const transact = storage.transact.bind(storage);
  let broken = false;
  storage.transact = (work) =>
    transact((tx) =>
      work({
        ...tx,
        inboxLedger: {
          ...tx.inboxLedger,
          complete: async (key) => {
            if (!broken) {
              broken = true;
              throw new Error("connection lost");
            }
            return tx.inboxLedger.complete(key);
          },
        },
      } satisfies StorageTransaction),
    );
  return { broke: () => broken };
};

describe("createUnitOfWork", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const key = { handler: "order.p", eventId: "e1" };
  const context = { correlationId: "c", causationId: "c", depth: 0 };
  const letter = (id: string) => ({
    id,
    kind: "policy" as const,
    handler: "order.p",
    eventId: "e1",
    eventType: "OrderPlaced",
    aggregateType: "order",
    aggregateId: "1",
    errorType: "terminal" as const,
    errorMessage: "boom",
    attempts: 1,
    firstFailedAt: now.toISOString(),
    lastFailedAt: now.toISOString(),
  });
  const entry = (dedupeKey: string) => ({
    dedupeKey,
    command: { type: "Remind", aggregateId: "1", payload: {} },
    executeAt: now,
    context,
  });

  it("reads through to the store and holds every write until commit, events first", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    await storage.deadLetterStore.add(letter("old"));
    await storage.scheduler.schedule(entry("command:due"));
    const claimId = await storage.inboxLedger.tryClaim({ ...key, now, leaseMs: 1_000 });
    const [held] = await storage.scheduler.claimDue({ now, limit: 1, leaseMs: 1_000 });
    const unit = createUnitOfWork({ storage });

    expect(await unit.deadLetterStore.get("old")).toMatchObject({ id: "old" });
    expect(await unit.deadLetterStore.count()).toBe(1);
    expect((await unit.deadLetterStore.list()).map((item) => item.id)).toEqual(["old"]);
    expect(await unit.inboxLedger.get(key)).toMatchObject({ status: "pending", claimId });
    expect(await unit.scheduler.nextDueAt({ leaseMs: 1_000 })).toBeInstanceOf(Date);
    expect((await unit.scheduler.list()).map((item) => item.dedupeKey)).toEqual(["command:due"]);

    await unit.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1 })],
    });
    expect(await unit.deadLetterStore.add(letter("new"))).toEqual({
      ...letter("new"),
      status: "failed",
    });
    await unit.deadLetterStore.updateStatus("old", "discarded");
    await unit.deadLetterStore.remove("old");
    await unit.scheduler.schedule(entry("command:later"));
    await unit.scheduler.cancel("command:later");
    await unit.scheduler.schedule(entry("command:kept"));
    await unit.scheduler.complete(held as NonNullable<typeof held>);
    await unit.inboxLedger.fail({ ...key, error: "boom" });
    await unit.inboxLedger.complete({ ...key, claimId: claimId ?? undefined });

    expect(await storage.eventStore.lastPosition()).toBe(0);
    expect(await storage.deadLetterStore.count()).toBe(1);
    expect((await storage.scheduler.list()).map((item) => item.dedupeKey)).toEqual(["command:due"]);
    await unit.commit();
    expect(await storage.eventStore.lastPosition()).toBe(1);
    expect((await storage.deadLetterStore.list()).map((item) => item.id)).toEqual(["new"]);
    expect((await storage.scheduler.list()).map((item) => item.dedupeKey)).toEqual([
      "command:kept",
    ]);
    expect(await storage.inboxLedger.get(key)).toMatchObject({
      status: "succeeded",
      lastError: "boom",
    });
  });

  it("hands a claimed scheduler entry back through fail and defer", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    await storage.scheduler.schedule(entry("command:a"));
    await storage.scheduler.schedule(entry("command:b"));
    const [a, b] = await storage.scheduler.claimDue({ now, limit: 2, leaseMs: 1_000 });
    const unit = createUnitOfWork({ storage });
    await unit.scheduler.fail({
      claim: a as NonNullable<typeof a>,
      error: "boom",
      retryAt: new Date(now.getTime() + 5_000),
    });
    await unit.scheduler.defer({
      claim: b as NonNullable<typeof b>,
      executeAt: new Date(now.getTime() + 9_000),
    });
    expect(await storage.scheduler.claimDue({ now, limit: 2, leaseMs: 1_000 })).toEqual([]);
    await unit.commit();
    expect(
      (await storage.scheduler.list()).map((item) => [
        item.dedupeKey,
        item.executeAt,
        item.attempts,
      ]),
    ).toEqual([
      ["command:a", new Date(now.getTime() + 5_000).toISOString(), 1],
      ["command:b", new Date(now.getTime() + 9_000).toISOString(), 0],
    ]);
  });

  it("opens no transaction when nothing was staged", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const transact = storage.transact.bind(storage);
    let transactions = 0;
    storage.transact = (work) => {
      transactions += 1;
      return transact(work);
    };
    const unit = createUnitOfWork({ storage });
    await unit.eventStore.load({ aggregateType: "order", aggregateId: "1" });
    expect(await unit.inboxLedger.get(key)).toBeNull();
    await unit.commit();
    expect(transactions).toBe(0);
    await unit.scheduler.cancel("command:none");
    await unit.commit();
    expect(transactions).toBe(1);
  });

  it("commits nothing when a stream moved since the unit loaded it", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const unit = createUnitOfWork({ storage });
    const loaded = await unit.eventStore.load({ aggregateType: "order", aggregateId: "1" });
    await unit.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: loaded.version,
      events: [pendingEvent({ aggregateId: "1", version: 1, id: "mine" })],
    });
    await unit.scheduler.schedule(entry("command:mine"));
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1, id: "theirs" })],
    });
    await expect(unit.commit()).rejects.toBeInstanceOf(ConcurrencyError);
    expect(await storage.scheduler.list()).toEqual([]);
    expect(
      (await storage.eventStore.load({ aggregateType: "order", aggregateId: "1" })).events.map(
        (event) => event.id,
      ),
    ).toEqual(["theirs"]);
  });

  it("runs what waits for the commit once the unit has committed, with or without writes, and never for a commit that fails", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const ran: string[] = [];
    const empty = createUnitOfWork({ storage });
    empty.afterCommit(() => ran.push("empty"));
    const written = createUnitOfWork({ storage });
    await written.scheduler.schedule(entry("command:written"));
    written.afterCommit(() => ran.push("first"));
    written.afterCommit(() => ran.push("second"));
    expect(ran).toEqual([]);
    await empty.commit();
    await written.commit();
    await written.commit();
    expect(ran).toEqual(["empty", "first", "second"]);

    const moved = createUnitOfWork({ storage });
    const loaded = await moved.eventStore.load({ aggregateType: "order", aggregateId: "1" });
    await moved.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: loaded.version,
      events: [pendingEvent({ aggregateId: "1", version: 1, id: "mine" })],
    });
    moved.afterCommit(() => ran.push("moved"));
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "1", version: 1, id: "theirs" })],
    });
    await expect(moved.commit()).rejects.toBeInstanceOf(ConcurrencyError);
    expect(ran).toEqual(["empty", "first", "second"]);
  });

  it("runs the work again on a fresh unit when the commit finds a stream moved, as many times as allowed, then lets the conflict through", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const moveTheStream = () =>
      storage.eventStore.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: 0,
        events: [pendingEvent({ aggregateId: "1", version: 1, id: "theirs" })],
      });
    const units: UnitOfWork[] = [];
    const work = async (unit: UnitOfWork) => {
      units.push(unit);
      const loaded = await unit.eventStore.load({ aggregateType: "order", aggregateId: "1" });
      if (units.length === 1) await moveTheStream();
      await unit.eventStore.append({
        aggregateType: "order",
        aggregateId: "1",
        expectedVersion: loaded.version,
        events: [pendingEvent({ aggregateId: "1", version: loaded.version + 1, id: "mine" })],
      });
    };
    await commitAttempt({ storage, concurrencyRetries: 1, work });
    expect(units).toHaveLength(2);
    expect(new Set(units).size).toBe(2);
    expect(
      (await storage.eventStore.load({ aggregateType: "order", aggregateId: "1" })).events.map(
        (event) => event.id,
      ),
    ).toEqual(["theirs", "mine"]);

    const stale = async (unit: UnitOfWork) => {
      const stream = { aggregateType: "order", aggregateId: "2" };
      const loaded = await unit.eventStore.load(stream);
      await unit.eventStore.append({
        ...stream,
        expectedVersion: loaded.version,
        events: [pendingEvent({ aggregateId: "2", version: loaded.version + 1 })],
      });
      const live = await storage.eventStore.load(stream);
      await storage.eventStore.append({
        ...stream,
        expectedVersion: live.version,
        events: [pendingEvent({ aggregateId: "2", version: live.version + 1 })],
      });
    };
    let attempts = 0;
    await expect(
      commitAttempt({
        storage,
        concurrencyRetries: 2,
        work: (unit) => {
          attempts += 1;
          return stale(unit);
        },
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect(attempts).toBe(3);
  });

  it("runs beforeRerun before each rerun only, and ends the attempt with what it throws", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const steps: string[] = [];
    const stale = async (unit: UnitOfWork) => {
      steps.push("work");
      const stream = { aggregateType: "order", aggregateId: "3" };
      const loaded = await unit.eventStore.load(stream);
      await unit.eventStore.append({
        ...stream,
        expectedVersion: loaded.version,
        events: [pendingEvent({ aggregateId: "3", version: loaded.version + 1 })],
      });
      const live = await storage.eventStore.load(stream);
      await storage.eventStore.append({
        ...stream,
        expectedVersion: live.version,
        events: [pendingEvent({ aggregateId: "3", version: live.version + 1 })],
      });
    };
    let reruns = 0;
    await expect(
      commitAttempt({
        storage,
        concurrencyRetries: 3,
        work: stale,
        beforeRerun: async () => {
          steps.push("rerun");
          reruns += 1;
          if (reruns === 2) throw new Error("claim moved");
        },
      }),
    ).rejects.toThrow("claim moved");
    expect(steps).toEqual(["work", "rerun", "work", "rerun"]);
  });

  it("tells a commit that failed for another reason apart from what the work threw", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    breakNextCommit(storage);
    const failed = await commitAttempt({
      storage,
      concurrencyRetries: 3,
      work: (unit) => unit.scheduler.schedule(entry("command:c1")),
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CommitFailed);
    expect(failed).toMatchObject({
      name: "CommitFailed",
      message: "commit failed",
      cause: expect.objectContaining({ message: "connection lost" }),
    });
    expect(await storage.scheduler.list()).toEqual([]);
    await expect(
      commitAttempt({
        storage,
        concurrencyRetries: 3,
        work: async () => {
          throw new ValidationError("refused", []);
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("hands a commit failure on as the store threw it, for a caller that does not tell it apart", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    breakNextCommit(storage);
    const failed = await commitWork({
      storage,
      concurrencyRetries: 3,
      work: (unit) => unit.scheduler.schedule(entry("command:c1")),
    }).catch((error: unknown) => error);
    expect(failed).not.toBeInstanceOf(CommitFailed);
    expect(failed).toMatchObject({ message: "connection lost" });
    await commitWork({
      storage,
      concurrencyRetries: 3,
      work: (unit) => unit.scheduler.schedule(entry("command:c1")),
    });
    expect((await storage.scheduler.list()).map((scheduled) => scheduled.dedupeKey)).toEqual([
      "command:c1",
    ]);
  });
});

describe.each(adapters)("a reaction attempt as a unit of work on %s", (_name, adapter) => {
  const policyHarness = (retry: RetryConfig = { strategy: "none" }) =>
    createReactiveHarness({
      registry: policyRegistry,
      config: { runtime: { policies: { retry } } },
      adapter: adapter(),
    });

  it("writes a successful attempt's immediate command, scheduled command and claim together", async () => {
    reset("ok");
    const harness = await policyHarness();
    await place(harness);
    await settle(harness);

    expect(await orderTypes(harness)).toEqual(["OrderPlaced", "OrderPaid"]);
    expect(await scheduledTypes(harness)).toEqual(["ArchiveOrder"]);
    expect(await claimOf(harness, "order.settleOnOrderPlaced")).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(seen[0]).toMatchObject({ scheduled: false, version: 2, eventTypes: ["OrderPaid"] });
    expect((await harness.dispatcher.getLag()).maxLag).toBe(0);
  });

  it("leaves nothing of an attempt that fails after dispatching: not the immediate command, not the scheduled one", async () => {
    reset("refuse");
    const harness = await policyHarness();
    await place(harness);
    await settle(harness);

    expect(await orderTypes(harness)).toEqual(["OrderPlaced"]);
    expect(await scheduledTypes(harness)).toEqual([]);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { handler: "order.settleOnOrderPlaced", errorType: "terminal" },
    ]);
    expect(await claimOf(harness, "order.settleOnOrderPlaced")).toMatchObject({
      status: "succeeded",
      lastError: "provider refused",
    });
    expect(providerCalls).toHaveLength(1);
  });

  it("leaves only the claim when the runtime dies before the commit, and the next lease decides afresh", async () => {
    reset("ok");
    const harness = await policyHarness();
    const crash = breakNextCommit(harness.storage);
    await place(harness);
    await settle(harness);

    expect(crash.broke()).toBe(true);
    expect(await orderTypes(harness)).toEqual(["OrderPlaced"]);
    expect(await scheduledTypes(harness)).toEqual([]);
    expect(await claimOf(harness, "order.settleOnOrderPlaced")).toMatchObject({
      status: "pending",
      attempts: 1,
    });

    pastPolicyLease(harness);
    await settle(harness);
    expect(await orderTypes(harness)).toEqual(["OrderPlaced", "OrderPaid"]);
    expect(await scheduledTypes(harness)).toEqual(["ArchiveOrder"]);
    expect(await claimOf(harness, "order.settleOnOrderPlaced")).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
    // The provider was called twice: at least once, under the same idempotency key.
    expect(providerCalls).toHaveLength(2);
    expect(new Set(providerCalls).size).toBe(1);
  });

  it("writes nothing of an attempt that finished but could not be marked done, then runs it again", async () => {
    reset("ok");
    const harness = await policyHarness();
    const lost = breakNextCompletion(harness.storage);
    await place(harness);
    await settle(harness);

    expect(lost.broke()).toBe(true);
    expect(await orderTypes(harness)).toEqual(["OrderPlaced"]);
    expect(await scheduledTypes(harness)).toEqual([]);

    pastPolicyLease(harness);
    await settle(harness);
    expect(await orderTypes(harness)).toEqual(["OrderPlaced", "OrderPaid"]);
    expect(await scheduledTypes(harness)).toEqual(["ArchiveOrder"]);
    expect(providerCalls).toHaveLength(2);
  });

  const processHarness = (retry: RetryConfig = { strategy: "none" }) =>
    createReactiveHarness({
      registry: processRegistry,
      config: { runtime: { processes: { retry, handlerTimeout: "1m" } } },
      adapter: adapter(),
    });

  it("writes a process step's start, its handler's commands, its deadline entry and its claim together", async () => {
    reset("ok");
    const harness = await processHarness();
    await place(harness);
    await settle(harness);

    expect(await orderTypes(harness)).toEqual(["OrderPlaced", "OrderPaid"]);
    expect(await processTypes(harness)).toEqual([PROCESS_EVENTS.started, PROCESS_EVENTS.handled]);
    expect((await scheduledTypes(harness)).sort()).toEqual([
      "ArchiveOrder",
      "bounda.ProcessDeadline",
    ]);
    expect(await claimOf(harness, "order.settlement")).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(seen[0]).toMatchObject({ scheduled: false, version: 2, eventTypes: ["OrderPaid"] });
  });

  it("writes ProcessFailed, the dead letter and the claim together, or neither, and then gives up again", async () => {
    reset("refuse");
    const harness = await processHarness();
    const crash = breakNextCommit(harness.storage);
    await place(harness);
    await settle(harness);

    expect(crash.broke()).toBe(true);
    expect(await orderTypes(harness)).toEqual(["OrderPlaced"]);
    expect(await processTypes(harness)).toEqual([]);
    expect(await scheduledTypes(harness)).toEqual([]);
    expect(await harness.storage.deadLetterStore.list()).toEqual([]);
    expect(await claimOf(harness, "order.settlement")).toMatchObject({
      status: "pending",
      attempts: 1,
    });

    pastProcessLease(harness);
    await settle(harness);
    expect(await orderTypes(harness)).toEqual(["OrderPlaced"]);
    expect(await processTypes(harness)).toEqual([PROCESS_EVENTS.started, PROCESS_EVENTS.failed]);
    expect(await scheduledTypes(harness)).toEqual([]);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { handler: "order.settlement", errorType: "terminal", errorMessage: "provider refused" },
    ]);
    expect(await claimOf(harness, "order.settlement")).toMatchObject({
      status: "succeeded",
      attempts: 2,
      lastError: "provider refused",
    });
    expect(providerCalls).toHaveLength(2);
  });

  it("gives the handler each command's result at once, its rejection included, and commits the compensation with the rest", async () => {
    reset("compensate");
    const harness = await policyHarness();
    await place(harness);
    await settle(harness);

    expect(seen[0]).toMatchObject({ rejected: false, version: 2, eventTypes: ["OrderPaid"] });
    expect(seen[1]).toEqual({
      rejected: "NotPlaced",
      message: "Only placed orders can be paid; this one is paid",
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(await orderTypes(harness)).toEqual(["OrderPlaced", "OrderPaid"]);
    expect(await scheduledTypes(harness)).toEqual(["ArchiveOrder"]);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
  });
});
