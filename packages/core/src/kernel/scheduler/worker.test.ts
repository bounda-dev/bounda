import { describe, expect, it, vi } from "vitest";
import { ConcurrencyError, DomainError } from "../../contracts/errors.ts";
import type { PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";
import { createReactiveHarness } from "../reactive-harness.ts";
import { COMMAND_FAILED_EVENT } from "../system-events.ts";
import {
  advanceUntilWaiting,
  createRecordingLogger,
  eventually,
  orderRegistry,
  placeOrderKeys,
  sentMessages,
} from "../test-support.ts";

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

  it("runs a command scheduled again under its key while it ran, once the run ends", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    await harness.pipeline.dispatch({
      type: "PlaceOrder",
      payload: { orderId: "o-1", total: 10 },
      options: { delay: "1m" },
    });
    const [entry] = await harness.storage.scheduler.list();
    if (entry === undefined) throw new Error("nothing scheduled");
    const dispatch = harness.pipeline.dispatch;
    vi.spyOn(harness.pipeline, "dispatch").mockImplementationOnce(async (args) => {
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

  it("drops a command that fails for good, records CommandFailed and dead-letters it", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
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
    expect(order.events.map((event) => event.type)).toEqual(["OrderPlaced", COMMAND_FAILED_EVENT]);
    expect(order.events[1]).toMatchObject({
      payload: { commandType: "PlaceOrder", error: "Order already placed", attempts: 1 },
      metadata: { system: true },
    });
    expect(await harness.storage.deadLetterStore.list()).toMatchObject([
      {
        kind: "command",
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
  });

  it("reschedules transient failures with back-off and gives up after the configured attempts", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: {
        runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 2, baseDelay: "30s" } } },
      },
    });
    const original = harness.pipeline.dispatch.bind(harness.pipeline);
    let failures = 5;
    harness.pipeline.dispatch = async (args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("db unavailable");
      }
      return original(args);
    };
    await original({
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
        kind: "command",
        errorType: "retriable_exhausted",
        attempts: 2,
        errorMessage: "db unavailable",
        errorStack: expect.stringContaining("db unavailable"),
      },
    ]);
  });

  it("runs a delayed command with the id it was scheduled with, on every retry", async () => {
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
    const original = harness.storage.eventStore.append.bind(harness.storage.eventStore);
    let failures = 1;
    harness.storage.eventStore.append = async (args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("db unavailable");
      }
      return original(args);
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
    expect(order.events[0]?.metadata.causationId).toBe("id-1");
  });

  it("drops a retriable failure at once when retries are off", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    const original = harness.pipeline.dispatch.bind(harness.pipeline);
    harness.pipeline.dispatch = async () => {
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

  it("claims due commands with a lease of twice the handler timeout", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: { runtime: { policies: { timeout: "10s" } } },
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

  it("holds its claims long enough for the slowest aggregate's handlers", async () => {
    const harness = await createReactiveHarness({
      registry: orderRegistry,
      config: {
        runtime: {
          policies: { timeout: "10s" },
          overrides: { order: { policies: { timeout: "1m" } }, other: { policies: {} } },
        },
      },
    });
    expect(harness.worker.leaseMs).toBe(120_000);
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
    harness.pipeline.dispatch = async () => {
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

  it("does not record CommandFailed for domain errors on unknown aggregates and polls in the background", async () => {
    const harness = await createReactiveHarness({ registry: orderRegistry });
    harness.pipeline.dispatch = async () => {
      throw new DomainError("nope");
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

const noteRegistry = {
  aggregates: {
    note: {
      events: {
        noteWritten: {
          payload: ({ z }: PayloadArgs) => z.object({ text: z.string() }),
          apply: ({ state }: { state: object }) => state,
        },
      },
      commands: {
        writeNote: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ noteId: z.string(), text: z.string().transform((text) => `${text}!`) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { text: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => {
              receivedNotes.push(command.payload);
              if (rejectNotes) throw new DomainError("Notes are closed");
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

describe("delayed command payload", () => {
  it("is validated once, when the command runs", async () => {
    receivedNotes.length = 0;
    rejectNotes = false;
    const { app, clock } = await createTestApp({ registry: noteRegistry });
    await app.commands.writeNote({ noteId: "n-1", text: "hello" }, { delay: "1m" });

    clock.advance(60_000);
    await app.processUntilIdle();

    expect(receivedNotes).toEqual([{ noteId: "n-1", text: "hello!" }]);
    await app.stop();
  });

  it("is validated once when a dropped command is replayed from its dead letter", async () => {
    receivedNotes.length = 0;
    rejectNotes = true;
    const { app, clock } = await createTestApp({ registry: noteRegistry });
    await app.commands.writeNote({ noteId: "n-1", text: "hello" }, { delay: "1m" });
    clock.advance(60_000);
    await app.processUntilIdle();
    const [letter] = await app.deadLetters.list();

    rejectNotes = false;
    receivedNotes.length = 0;
    await app.deadLetters.replay(letter?.id ?? "");

    expect(letter?.payload).toEqual({ noteId: "n-1", text: "hello" });
    expect(receivedNotes).toEqual([{ noteId: "n-1", text: "hello!" }]);
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
    await app.processUntilIdle();

    expect(receivedNotes).toEqual([{ noteId: "n-1", text: "hello!" }]);
    await app.stop();
  });

  it("carries a date its schema coerces from the JSON it is stored as", async () => {
    receivedNotes.length = 0;
    const { app, clock } = await createTestApp({ registry: noteRegistry });
    const until = new Date("2026-02-01T00:00:00.000Z");
    await app.commands.postponeNote({ noteId: "n-1", until }, { delay: "1m" });

    clock.advance(60_000);
    await app.processUntilIdle();

    expect(receivedNotes).toEqual([{ noteId: "n-1", until }]);
    await app.stop();
  });

  it("rejects at dispatch a field JSON cannot carry, which runs when not delayed", async () => {
    const { app } = await createTestApp({ registry: noteRegistry });
    const at = new Date("2026-02-01T00:00:00.000Z");

    await expect(app.commands.pinNote({ noteId: "n-1", at }, { delay: "1m" })).rejects.toThrow(
      "Invalid payload for delayed command PinNote",
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
    ).rejects.toThrow("Invalid payload for delayed command WriteNote");
    expect(await harness.storage.scheduler.list()).toEqual([]);
  });
});
