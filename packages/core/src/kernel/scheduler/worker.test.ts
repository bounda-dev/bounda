import { describe, expect, it, vi } from "vitest";
import type { ClaimedCommand } from "../../adapter/storage/scheduler.ts";
import type { RuntimeConfig } from "../../config/types.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";
import type { RejectFunction } from "../../modules/command.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { SCHEDULED_COMMAND_FAILED_EVENT } from "../system-events.ts";
import { ATTRIBUTES, METRICS } from "../telemetry.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import {
  advanceUntilWaiting,
  breakNextCommit,
  createRecordingLogger,
  eventually,
  orderAggregateEntry,
  orderRegistry,
  placeOrderKeys,
  sentMessages,
  slowJob,
} from "../test-support.ts";

const LOST_CLAIM = "scheduled command no longer holds its claim; this run wrote nothing";

const order = orderAggregateEntry();

// A scheduled command is dropped when it fails, never when it is rejected: placing an order twice
// fails here.
const failingRegistry: Registry = {
  aggregates: {
    order: {
      ...order,
      commands: {
        ...order.commands,
        placeOrder: {
          module: {
            ...order.commands.placeOrder.module,
            handler: (args: Parameters<typeof order.commands.placeOrder.module.handler>[0]) => {
              if (args.state.status !== "new") {
                throw new ValidationError("Order already placed", []);
              }
              return order.commands.placeOrder.module.handler(args);
            },
          },
        },
      },
    },
  },
  readModels: {},
};

describe("scheduled command worker", () => {
  it("runs due commands with their stored context and completes them", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    sentMessages.length = 0;
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: "10m", correlationId: "req-7" },
    });
    expect(await harness.worker.runOnce()).toBe(0);
    expect(sentMessages).toEqual([]);

    harness.clock.advance(600_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(sentMessages).toEqual(["placed o-1 v0"]);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(order.events[0]?.metadata).toMatchObject({ correlationId: "req-7", depth: 0 });
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.worker.runOnce()).toBe(0);
  });

  it("commits a run with the release of its claim, or neither, so a crash after the run does not run it twice", async () => {
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      logger,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "1s" } } },
      },
    });
    sentMessages.length = 0;
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    const crash = breakNextCommit(harness.storage);
    expect(await harness.worker.runOnce()).toBe(1);

    expect(crash.broke()).toBe(true);
    expect(sentMessages).toEqual(["placed o-1 v0"]);
    const order = { aggregateType: "order", aggregateId: "o-1" };
    expect((await harness.storage.eventStore.load(order)).events).toEqual([]);
    expect(await harness.storage.scheduler.list()).toMatchObject([{ attempts: 1 }]);
    expect(entries).toContainEqual({
      level: "warn",
      message: "scheduled command failed; rescheduled",
      fields: expect.objectContaining({ command: "PlaceOrder", attempts: 1 }),
    });

    expect(await harness.worker.runOnce()).toBe(0);
    harness.clock.advance(1_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(sentMessages).toEqual(["placed o-1 v0", "placed o-1 v0"]);
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual(["OrderPlaced"]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });

  it("drops a command with its dead letter, ScheduledCommandFailed and the claim's failure together, or neither", async () => {
    const harness = await createReactiveHarness({ registry: failingRegistry });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 99 },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    const crash = breakNextCommit(harness.storage);
    expect(await harness.worker.runOnce()).toBe(1);

    expect(crash.broke()).toBe(true);
    const order = { aggregateType: "order", aggregateId: "o-1" };
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual(["OrderPlaced"]);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
    expect(await harness.storage.scheduler.list()).toHaveLength(1);

    harness.clock.advance(harness.worker.leaseMs + 1);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(
      (await harness.storage.eventStore.load(order)).events.map((event) => event.type),
    ).toEqual(["OrderPlaced", SCHEDULED_COMMAND_FAILED_EVENT]);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { kind: "scheduled", eventType: "PlaceOrder", errorMessage: "Order already placed" },
    ]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });

  it("runs a command scheduled again under its key while it ran, once the run ends", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: "1m" },
    });
    const [entry] = await harness.storage.scheduler.list();
    if (entry === undefined) throw new Error("nothing scheduled");
    const dispatch = harness.pipeline.dispatchUnattended;
    vi.spyOn(harness.pipeline, "dispatchUnattended").mockImplementationOnce(async (args) => {
      await harness.storage.scheduler.schedule({
        dedupeKey: entry.dedupeKey,
        command: { ...entry.command, payload: { orderId: "o-2", total: 5 } },
        executeAt: harness.clock.now(),
        context: entry.context,
      });
      return dispatch(args);
    });

    harness.clock.advance(60_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(await harness.worker.runOnce()).toBe(1);

    const second = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-2",
    });
    expect(second.events.map((event) => event.type)).toEqual(["OrderPlaced"]);
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });

  it("drops a command that fails for good, records ScheduledCommandFailed and dead-letters it", async () => {
    const telemetry = installFakeTelemetry();
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({ registry: failingRegistry, logger });
    await harness.pipeline.dispatch({ type: "PlaceOrder", payload: { orderId: "o-1", total: 10 } });
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 99 },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    expect(await harness.worker.runOnce()).toBe(1);

    expect(await harness.storage.scheduler.list()).toEqual([]);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(order.events.map((event) => event.type)).toEqual([
      "OrderPlaced",
      SCHEDULED_COMMAND_FAILED_EVENT,
    ]);
    expect(order.events[1]).toMatchObject({
      payload: { commandType: "PlaceOrder", error: "Order already placed", attempts: 1 },
      metadata: { system: true },
    });
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        kind: "scheduled",
        eventType: "PlaceOrder",
        aggregateType: "order",
        aggregateId: "o-1",
        errorType: "terminal",
        payload: { orderId: "o-1", total: 99 },
      },
    ]);
    await expect(
      harness.pipeline.dispatch({ type: "PayOrder", payload: { orderId: "o-1", method: "card" } }),
    ).resolves.toMatchObject({ version: 3 });
    expect(telemetry.counts).toContainEqual({
      metric: METRICS.deadLetters,
      value: 1,
      attributes: {
        [ATTRIBUTES.handlerKind]: "scheduled",
        [ATTRIBUTES.handler]: "PlaceOrder",
        [ATTRIBUTES.outcome]: "terminal",
      },
    });
    telemetry.restore();
    expect(entries).toContainEqual({
      level: "warn",
      message: "scheduled command dropped",
      fields: {
        command: "PlaceOrder",
        dedupeKey: expect.stringMatching(/^command:/),
        reason: "terminal",
        attempts: 1,
      },
    });
  });

  it("reschedules transient failures with back-off and gives up after the configured attempts", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 2, baseDelay: "30s" } } },
      },
    });
    const original = harness.pipeline.dispatchUnattended.bind(harness.pipeline);
    let failures = 5;
    harness.pipeline.dispatchUnattended = async (args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("db unavailable");
      }
      return original(args);
    };
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: 0 },
    });

    expect(await harness.worker.runOnce()).toBe(1);
    const [rescheduled] = await harness.storage.scheduler.list();
    expect(rescheduled).toMatchObject({ attempts: 1, executeAt: "2026-01-01T00:00:30.000Z" });

    harness.clock.advance(29_000);
    expect(await harness.worker.runOnce()).toBe(0);
    harness.clock.advance(1_000);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        kind: "scheduled",
        errorType: "retriable_exhausted",
        attempts: 2,
        errorMessage: "db unavailable",
        errorStack: expect.stringContaining("db unavailable"),
      },
    ]);
  });

  it("retries a command as its aggregate's override says", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: {
        runtime: {
          policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "30s" } },
          overrides: {
            order: { policies: { retry: { strategy: "fixed", maxAttempts: 2, baseDelay: "5s" } } },
          },
        },
      },
    });
    harness.pipeline.dispatchUnattended = async () => {
      throw new Error("db unavailable");
    };
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: 0 },
    });

    await harness.worker.runOnce();
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { attempts: 1, executeAt: "2026-01-01T00:00:05.000Z" },
    ]);
    harness.clock.advance(5_000);
    await harness.worker.runOnce();
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      { errorType: "retriable_exhausted", attempts: 2 },
    ]);
  });

  it("runs a scheduled command with the id it was scheduled with, on every retry", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "30s" } } },
      },
    });
    placeOrderKeys.length = 0;
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: 0 },
    });
    const [scheduled] = await harness.storage.scheduler.list();
    const complete = harness.storage.scheduler.complete;
    let failures = 1;
    harness.storage.scheduler.complete = async (claim) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("db unavailable");
      }
      return complete(claim);
    };

    await harness.worker.runOnce();
    harness.clock.advance(30_000);
    await harness.worker.runOnce();

    expect(scheduled?.dedupeKey).toBe("command:id-1");
    expect(placeOrderKeys).toEqual(["id-1", "id-1"]);
    const order = await harness.storage.eventStore.load({
      aggregateType: "order",
      aggregateId: "o-1",
    });
    expect(order.events[0]?.metadata).toMatchObject({ causationId: "id-1", commandId: "id-1" });
  });

  it("drops a retriable failure at once when retries are off", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    const original = harness.pipeline.dispatch.bind(harness.pipeline);
    harness.pipeline.dispatchUnattended = async () => {
      const bare = new Error("db unavailable");
      Reflect.deleteProperty(bare, "stack");
      throw bare;
    };
    await original({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: 0 },
    });
    expect(await harness.worker.runOnce()).toBe(1);
    expect(await harness.storage.scheduler.list()).toEqual([]);
    const [letter] = await harness.storage.deadLetterStore.list();
    expect(letter).toMatchObject({
      errorType: "retriable_exhausted",
      attempts: 1,
      errorMessage: "db unavailable",
    });
    expect(letter).not.toHaveProperty("errorStack");
  });

  it("reschedules a command whose handler runs out of time", async () => {
    const { registry, started } = slowJob();
    const harness = await createReactiveHarness({
      registry,
      config: { runtime: { commands: { timeout: "1s" } } },
    });
    await harness.pipeline.dispatch({
      type: "RunJob",
      payload: { jobId: "j-1" },
      options: { delay: "1m" },
    });
    harness.clock.advance(60_000);
    const running = harness.worker.runOnce();
    await started;
    harness.clock.advance(1_000);

    expect(await running).toBe(1);
    expect(await harness.storage.scheduler.list()).toMatchObject([
      { command: { type: "RunJob" }, attempts: 1 },
    ]);
    expect(await harness.storage.deadLetterStore.count()).toBe(0);
  });

  it("claims due commands with a lease of twice the handler timeout", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: {
        runtime: {
          commands: { timeout: "5s" },
          policies: { timeout: "10s" },
          processes: { handlerTimeout: "5s" },
        },
      },
    });
    const leases: number[] = [];
    const original = harness.storage.scheduler.claimDue.bind(harness.storage.scheduler);
    harness.storage.scheduler.claimDue = async (args) => {
      leases.push(args.leaseMs);
      return original(args);
    };
    await harness.worker.runOnce();
    expect(leases).toEqual([20_000]);
  });

  it.each<[string, RuntimeConfig, number]>([
    ["commands", { commands: { timeout: "40s" } }, 80_000],
    ["policies", { policies: { timeout: "40s" } }, 80_000],
    ["processes, whose deadlines it runs", { processes: { handlerTimeout: "40s" } }, 80_000],
    [
      "one aggregate's commands",
      { overrides: { order: { commands: { timeout: "1m" } } } },
      120_000,
    ],
    [
      "one aggregate's policies",
      { overrides: { order: { policies: { timeout: "1m" } }, other: { policies: {} } } },
      120_000,
    ],
    [
      "one aggregate's processes",
      { overrides: { order: { processes: { handlerTimeout: "1m" } } } },
      120_000,
    ],
  ])("holds its claims long enough for the slowest handler: %s", async (_, slowest, leaseMs) => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: {
        runtime: {
          commands: { timeout: "10s" },
          policies: { timeout: "10s" },
          processes: { handlerTimeout: "10s" },
          ...slowest,
        },
      },
    });
    expect(harness.worker.leaseMs).toBe(leaseMs);
  });

  it.each([
    ["succeeds", () => undefined, 0],
    [
      "fails for good",
      () => {
        throw new ValidationError("Orders are closed", []);
      },
      1,
    ],
    [
      "fails and would retry",
      () => {
        throw new Error("db unavailable");
      },
      1,
    ],
  ])(
    "writes nothing of a run that %s after another instance took its claim over",
    async (_, outcome, failures) => {
      const { logger, entries } = createRecordingLogger();
      const harness = await createReactiveHarness({ registry: orderRegistry, logger });
      await harness.pipeline.dispatch({
        type: "PlaceOrder",
        payload: { orderId: "o-1", total: 10 },
        options: { delay: "1m" },
      });
      harness.clock.advance(60_000);
      let takenOver: readonly ClaimedCommand[] = [];
      const dispatch = harness.pipeline.dispatchUnattended;
      vi.spyOn(harness.pipeline, "dispatchUnattended").mockImplementationOnce(async (args) => {
        const result = await dispatch(args);
        harness.clock.advance(harness.worker.leaseMs + 1);
        takenOver = await harness.storage.scheduler.claimDue({
          now: harness.clock.now(),
          limit: 10,
          leaseMs: harness.worker.leaseMs,
        });
        outcome();
        return result;
      });

      const fail = vi.spyOn(harness.storage.scheduler, "fail");
      expect(await harness.worker.runOnce()).toBe(1);

      expect(fail).toHaveBeenCalledTimes(failures);
      expect(takenOver).toHaveLength(1);
      expect(await harness.storage.eventStore.lastPosition()).toBe(0);
      expect(await harness.storage.deadLetterStore.count()).toBe(0);
      expect(await harness.storage.scheduler.list()).toMatchObject([{ attempts: 1 }]);
      expect(entries).toEqual([
        {
          level: "warn",
          message: LOST_CLAIM,
          fields: { command: "PlaceOrder", dedupeKey: expect.stringMatching(/^command:/) },
        },
      ]);
      const [current] = takenOver;
      if (current === undefined) throw new Error("nothing taken over");
      await harness.storage.scheduler.complete(current);
      expect(await harness.storage.scheduler.list()).toEqual([]);
    },
  );

  it("runs none of the entries of its batch another instance took over before it reached them", async () => {
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({ registry: orderRegistry, logger });
    sentMessages.length = 0;
    for (const orderId of ["o-1", "o-2", "o-3"]) {
      await harness.pipeline.dispatch({
        type: "PlaceOrder",
        payload: { orderId, total: 10 },
        options: { delay: "1m" },
      });
    }
    harness.clock.advance(60_000);
    let takenOver: readonly ClaimedCommand[] = [];
    const dispatch = harness.pipeline.dispatchUnattended;
    vi.spyOn(harness.pipeline, "dispatchUnattended").mockImplementationOnce(async (args) => {
      const result = await dispatch(args);
      harness.clock.advance(harness.worker.leaseMs + 1);
      takenOver = await harness.storage.scheduler.claimDue({
        now: harness.clock.now(),
        limit: 10,
        leaseMs: harness.worker.leaseMs,
      });
      return result;
    });

    expect(await harness.worker.runOnce()).toBe(3);

    expect(takenOver).toHaveLength(3);
    expect(sentMessages).toHaveLength(1);
    expect(await harness.storage.eventStore.lastPosition()).toBe(0);
    expect(entries.map((entry) => entry.message)).toEqual(
      Array.from({ length: 3 }, () => LOST_CLAIM),
    );
  });

  it("hands back unrun, without an attempt, the entries of a batch it reaches too late in their lease", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    sentMessages.length = 0;
    for (const orderId of ["o-1", "o-2", "o-3"]) {
      await harness.pipeline.dispatch({
        type: "PlaceOrder",
        payload: { orderId, total: 10 },
        options: { delay: "1m" },
      });
    }
    harness.clock.advance(60_000);
    const dispatch = harness.pipeline.dispatchUnattended;
    const slow =
      (ms: number): typeof dispatch =>
      async (args) => {
        harness.clock.advance(ms);
        return dispatch(args);
      };
    vi.spyOn(harness.pipeline, "dispatchUnattended")
      .mockImplementationOnce(slow(harness.worker.leaseMs / 4))
      .mockImplementationOnce(slow(1));

    expect(await harness.worker.runOnce()).toBe(3);

    expect(sentMessages).toHaveLength(2);
    expect(await harness.storage.scheduler.list()).toMatchObject([{ attempts: 0 }]);
    expect(await harness.worker.runOnce()).toBe(1);
    expect(sentMessages).toHaveLength(3);
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });

  describe("a run that meets a conflict", () => {
    const conflicting = async (harness: Awaited<ReturnType<typeof createReactiveHarness>>) => {
      await harness.pipeline.dispatch({
        type: "PlaceOrder",
        payload: { orderId: "o-1", total: 10 },
        options: { delay: "1m" },
      });
      harness.clock.advance(60_000);
      const dispatch = harness.pipeline.dispatchUnattended;
      const runs = vi
        .spyOn(harness.pipeline, "dispatchUnattended")
        .mockImplementationOnce(async (args) => {
          const result = await dispatch(args);
          await harness.pipeline.dispatch({
            type: "PlaceOrder",
            payload: { orderId: "o-1", total: 10 },
          });
          return result;
        });
      return runs;
    };

    const afterTheConflict = (
      harness: Awaited<ReturnType<typeof createReactiveHarness>>,
      then: () => Promise<unknown>,
    ): void => {
      const transact = harness.storage.transact.bind(harness.storage);
      harness.storage.transact = async (work) => {
        harness.storage.transact = transact;
        try {
          return await transact(work);
        } catch (error) {
          await then();
          throw error;
        }
      };
    };

    it("renews its claim before running again, and stops once the claim moved", async () => {
      const { logger, entries } = createRecordingLogger();
      const harness = await createReactiveHarness({ registry: orderRegistry, logger });
      const runs = await conflicting(harness);
      afterTheConflict(harness, async () => {
        harness.clock.advance(harness.worker.leaseMs + 1);
        await harness.storage.scheduler.claimDue({
          now: harness.clock.now(),
          limit: 10,
          leaseMs: harness.worker.leaseMs,
        });
      });

      expect(await harness.worker.runOnce()).toBe(1);

      expect(runs).toHaveBeenCalledTimes(1);
      const order = await harness.storage.eventStore.load({
        aggregateType: "order",
        aggregateId: "o-1",
      });
      expect(order.events.map((event) => event.type)).toEqual(["OrderPlaced"]);
      expect(await harness.storage.deadLetterStore.count()).toBe(0);
      expect(entries.map((entry) => entry.message)).toEqual([LOST_CLAIM]);
    });

    it("keeps its claim for the rerun, past the lease it was claimed with", async () => {
      const harness = await createReactiveHarness({ registry: orderRegistry });
      const runs = await conflicting(harness);
      const transact = harness.storage.transact.bind(harness.storage);
      let peer: readonly ClaimedCommand[] = [];
      afterTheConflict(harness, async () => {
        harness.clock.advance(harness.worker.leaseMs - 1);
        harness.storage.transact = async (work) => {
          peer = await harness.storage.scheduler.claimDue({
            now: new Date(harness.clock.now().getTime() + 2),
            limit: 10,
            leaseMs: harness.worker.leaseMs,
          });
          return transact(work);
        };
      });

      expect(await harness.worker.runOnce()).toBe(1);

      expect(peer).toEqual([]);
      expect(runs).toHaveBeenCalledTimes(2);
      expect(await harness.storage.scheduler.list()).toEqual([]);
    });

    it("leaves its claim to lapse when renewing it fails in the store, spending no attempt", async () => {
      const { logger, entries } = createRecordingLogger();
      const harness = await createReactiveHarness({ registry: orderRegistry, logger });
      const runs = await conflicting(harness);
      afterTheConflict(harness, async () => {
        harness.storage.scheduler.renew = async () => {
          throw new Error("connection reset");
        };
      });

      expect(await harness.worker.runOnce()).toBe(1);

      expect(runs).toHaveBeenCalledTimes(1);
      expect(await harness.storage.scheduler.list()).toMatchObject([{ attempts: 0 }]);
      expect(await harness.storage.deadLetterStore.count()).toBe(0);
      expect(entries).toEqual([
        {
          level: "error",
          message: "scheduled command could not be settled; its lease will lapse",
          fields: expect.objectContaining({ command: "PlaceOrder", message: "connection reset" }),
        },
      ]);
    });
  });

  it("arms one timer per interval, re-arms after each run and leaves nothing behind on stop", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    const scheduler = harness.storage.scheduler;
    const original = scheduler.claimDue.bind(scheduler);
    let release: () => void = () => undefined;
    let claims = 0;
    scheduler.claimDue = async (args) => {
      claims += 1;
      if (claims === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(args);
    };
    const interval = harness.config.runtime.dispatcher.pollIntervalMs;
    harness.worker.start();
    harness.worker.start();
    expect(harness.clock.pending()).toBe(1);

    await advanceUntilWaiting(harness.clock, interval);
    expect(claims).toBe(1);

    harness.clock.advance(interval);
    await eventually(() => expect(claims).toBe(2));
    expect(harness.clock.pending()).toBe(0);

    const stopping = harness.worker.stop();
    release();
    await stopping;
    expect(harness.clock.pending()).toBe(0);
    harness.clock.advance(interval * 5);
    expect(claims).toBe(2);
  });

  it("reports a failing run and keeps polling", async () => {
    const { logger, entries } = createRecordingLogger();
    const harness = await createReactiveHarness({ registry: orderRegistry, logger });
    sentMessages.length = 0;
    const scheduler = harness.storage.scheduler;
    const original = scheduler.claimDue.bind(scheduler);
    let failures = 1;
    scheduler.claimDue = async (args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("scheduler unavailable");
      }
      return original(args);
    };
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: 0 },
    });
    const interval = harness.config.runtime.dispatcher.pollIntervalMs;
    harness.worker.start();
    await advanceUntilWaiting(harness.clock, interval);
    expect(entries).toEqual([
      {
        level: "error",
        message: "scheduled command worker failed",
        fields: { message: "scheduler unavailable", stack: expect.any(String) },
      },
    ]);
    await advanceUntilWaiting(harness.clock, interval);
    expect(sentMessages).toEqual(["placed o-1 v0"]);
    await harness.worker.stop();
  });

  it("treats a concurrency conflict from the pipeline as transient", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    harness.pipeline.dispatchUnattended = async () => {
      throw new ConcurrencyError({ streamId: "order:o-1", expectedVersion: 0, actualVersion: 1 });
    };
    await harness.storage.scheduler.schedule({
      dedupeKey: "command:x",
      command: { type: "TouchOrder", aggregateId: "o-1", payload: { orderId: "o-1" } },
      executeAt: harness.clock.now(),
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });
    await harness.worker.runOnce();
    expect((await harness.storage.scheduler.list())[0]?.attempts).toBe(1);
  });

  it("does not record ScheduledCommandFailed for terminal errors on unknown aggregates and polls in the background", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    harness.pipeline.dispatchUnattended = async () => {
      throw new ValidationError("nope", []);
    };
    await harness.storage.scheduler.schedule({
      dedupeKey: "command:y",
      command: { type: "Unknown", aggregateId: "z", payload: {} },
      executeAt: harness.clock.now(),
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });
    harness.worker.start();
    harness.worker.start();
    expect(harness.clock.pending()).toBe(1);
    await advanceUntilWaiting(harness.clock, harness.config.runtime.dispatcher.pollIntervalMs);
    await harness.worker.stop();
    expect(await harness.storage.scheduler.list()).toEqual([]);
    expect(await harness.storage.deadLetterStore.count()).toBe(1);
    expect(await harness.storage.eventStore.lastPosition()).toBe(0);
  });
});

const receivedNotes: unknown[] = [];
let rejectNotes = false;
let closeNotes = false;

const noteRegistry = {
  aggregates: {
    note: {
      events: {
        noteWritten: {
          payload: ({ z }: PayloadArgs) => z.object({ text: z.string() }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {
        writeNote: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ noteId: z.string(), text: z.string().transform((text) => `${text}!`) }),
            rejections: () => ({ Closed: "Notes are closed" }),
            handler: ({
              command,
              events,
              reject,
            }: {
              command: { payload: { text: string } };
              events: Record<string, (payload?: unknown) => unknown>;
              reject: RejectFunction<"Closed">;
            }) => {
              receivedNotes.push(command.payload);
              if (closeNotes) return reject("Closed");
              if (rejectNotes) throw new ValidationError("Notes are unreadable", []);
              return [events.noteWritten?.({ text: command.payload.text })];
            },
          },
        },
        pinNote: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ noteId: z.string(), at: z.date() }),
            handler: () => [],
          },
        },
        postponeNote: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ noteId: z.string(), until: z.coerce.date() }),
            handler: ({ command }: { command: { payload: unknown } }) => {
              receivedNotes.push(command.payload);
              return [];
            },
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as const satisfies Registry;

describe("scheduled command payload", () => {
  it("is validated once, when the command runs", async () => {
    receivedNotes.length = 0;
    rejectNotes = false;
    const { app, clock } = await createTestApp({ registry: noteRegistry });
    await app.commands.writeNote({ noteId: "n-1", text: "hello" }, { delay: "1m" });

    clock.advance(60_000);
    await app.runUntilIdle();

    expect(receivedNotes).toEqual([{ noteId: "n-1", text: "hello!" }]);
    await app.stop();
  });

  it("is validated once when a dropped command is retried from its dead letter", async () => {
    receivedNotes.length = 0;
    rejectNotes = true;
    const { app, clock } = await createTestApp({ registry: noteRegistry });
    await app.commands.writeNote({ noteId: "n-1", text: "hello" }, { delay: "1m" });
    clock.advance(60_000);
    await app.runUntilIdle();
    const [letter] = await app.deadLetters.list();

    rejectNotes = false;
    receivedNotes.length = 0;
    await app.deadLetters.retry(letter?.id ?? "");

    expect(letter?.payload).toEqual({ noteId: "n-1", text: "hello" });
    expect(receivedNotes).toEqual([{ noteId: "n-1", text: "hello!" }]);
    await app.stop();
  });

  it("changes nothing when the handler rejects it, and is reported by runUntilIdle", async () => {
    receivedNotes.length = 0;
    closeNotes = true;
    const { logger, entries } = createRecordingLogger();
    const { app, clock } = await createTestApp({ registry: noteRegistry, logger });
    await app.commands.writeNote({ noteId: "n-1", text: "hello" }, { delay: "1m" });
    clock.advance(60_000);

    const { rejections } = await app.runUntilIdle();

    closeNotes = false;
    const rejection = {
      type: "WriteNote",
      rejected: "Closed",
      message: "Notes are closed",
      aggregateType: "note",
      aggregateId: "n-1",
    };
    expect(rejections).toEqual([rejection]);
    expect(entries).toContainEqual({
      level: "info",
      message: "command rejected",
      fields: rejection,
    });
    expect(await app.deadLetters.list()).toEqual([]);
    expect((await app.runUntilIdle()).rejections).toEqual([]);
    await app.stop();
  });

  it("reaches the handler as it was dispatched, though the caller changes it afterwards", async () => {
    receivedNotes.length = 0;
    rejectNotes = false;
    const { app, clock } = await createTestApp({ registry: noteRegistry });
    const payload = { noteId: "n-1", text: "hello" };
    await app.commands.writeNote(payload, { delay: "1m" });
    payload.text = "changed";

    clock.advance(60_000);
    await app.runUntilIdle();

    expect(receivedNotes).toEqual([{ noteId: "n-1", text: "hello!" }]);
    await app.stop();
  });

  it("carries a date its schema coerces from the JSON it is stored as", async () => {
    receivedNotes.length = 0;
    const { app, clock } = await createTestApp({ registry: noteRegistry });
    const until = new Date("2026-02-01T00:00:00.000Z");
    await app.commands.postponeNote({ noteId: "n-1", until }, { delay: "1m" });

    clock.advance(60_000);
    await app.runUntilIdle();

    expect(receivedNotes).toEqual([{ noteId: "n-1", until }]);
    await app.stop();
  });

  it("rejects at dispatch a field JSON cannot carry, which runs when not delayed", async () => {
    const { app } = await createTestApp({ registry: noteRegistry });
    const at = new Date("2026-02-01T00:00:00.000Z");

    await expect(app.commands.pinNote({ noteId: "n-1", at }, { delay: "1m" })).rejects.toThrow(
      "Invalid payload for scheduled command PinNote",
    );
    await expect(app.commands.pinNote({ noteId: "n-1", at })).resolves.toMatchObject({
      scheduled: false,
    });
    await app.stop();
  });

  it("rejects an invalid payload when the command is scheduled", async () => {
    const harness = await createReactiveHarness({ registry: noteRegistry });

    await expect(
      harness.pipeline.dispatch({
        type: "WriteNote",
        payload: { noteId: "n-1" },
        options: { delay: "1m" },
      }),
    ).rejects.toThrow("Invalid payload for scheduled command WriteNote");
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });
});
