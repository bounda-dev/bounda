import { describe, expect, it } from "vitest";
import { pendingEvent } from "../adapter/testing/fixtures.ts";
import { createFixedClock } from "../contracts/clock.ts";
import { ConcurrencyError } from "../contracts/errors.ts";
import { createSequentialIdGenerator } from "../contracts/ids.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import { appendSystemEvent, COMMAND_FAILED_EVENT } from "./system-events.ts";

const context = { correlationId: "corr", causationId: "cause", depth: 2 };

const setup = async () => {
  const storage = await memory().createStorage({ logger: silentLogger });
  const original = storage.eventStore.append.bind(storage.eventStore);
  let appends = 0;
  let conflicts = 0;
  storage.eventStore.append = async (args) => {
    appends += 1;
    if (conflicts > 0) {
      conflicts -= 1;
      throw new ConcurrencyError({ streamId: "order:o-1", expectedVersion: 0, actualVersion: 1 });
    }
    return original(args);
  };
  const append = () =>
    appendSystemEvent({
      eventStore: storage.eventStore,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(),
      aggregateType: "order",
      aggregateId: "o-1",
      type: COMMAND_FAILED_EVENT,
      payload: { commandType: "PayOrder", error: "boom", attempts: 3 },
      context,
    });
  return {
    storage,
    append,
    appends: () => appends,
    conflict: (times: number) => {
      conflicts = times;
    },
  };
};

describe("appendSystemEvent", () => {
  it("appends at the end of the stream, marked as a system event", async () => {
    const { storage, append } = await setup();
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [1, 2].map((version) => pendingEvent({ aggregateId: "o-1", version })),
    });
    const appended = await append();
    expect(appended).toEqual({
      id: "id-1",
      aggregateType: "order",
      aggregateId: "o-1",
      version: 3,
      position: 3,
      type: "CommandFailed",
      payload: { commandType: "PayOrder", error: "boom", attempts: 3 },
      timestamp: "2026-01-01T00:00:00.000Z",
      metadata: { ...context, schemaVersion: 1, system: true },
    });
    expect(COMMAND_FAILED_EVENT).toBe("CommandFailed");
  });

  it("reloads and retries when the stream moves under it", async () => {
    const { storage, append, appends, conflict } = await setup();
    conflict(2);
    await expect(append()).resolves.toMatchObject({ version: 1 });
    expect(appends()).toBe(3);
    expect(await storage.eventStore.lastPosition()).toBe(1);
  });

  it("gives up after five conflicts", async () => {
    const { append, appends, conflict } = await setup();
    conflict(99);
    await expect(append()).rejects.toBeInstanceOf(ConcurrencyError);
    expect(appends()).toBe(5);
  });

  it("does not retry other failures", async () => {
    const { storage, append, appends } = await setup();
    storage.eventStore.append = async () => {
      appends();
      throw new Error("disk full");
    };
    await expect(append()).rejects.toThrow("disk full");
    expect(appends()).toBe(0);
  });
});
