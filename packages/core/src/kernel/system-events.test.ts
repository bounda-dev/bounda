import { describe, expect, it } from "vitest";
import { pendingEvent } from "../adapter/testing/fixtures.ts";
import { createFixedClock } from "../contracts/clock.ts";
import { ConcurrencyError } from "../contracts/errors.ts";
import { createSequentialIdGenerator } from "../contracts/ids.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import { appendSystemEvent, SCHEDULED_COMMAND_FAILED_EVENT } from "./system-events.ts";

const context = { correlationId: "corr", causationId: "cause", depth: 2 };

const setup = async () => {
  const storage = await memory().createStorage({ logger: silentLogger });
  const append = () =>
    appendSystemEvent({
      eventStore: storage.eventStore,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(),
      aggregateType: "order",
      aggregateId: "o-1",
      type: SCHEDULED_COMMAND_FAILED_EVENT,
      payload: { commandType: "PayOrder", error: "boom", attempts: 3 },
      context,
    });
  return { storage, append };
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
      type: "ScheduledCommandFailed",
      payload: { commandType: "PayOrder", error: "boom", attempts: 3 },
      timestamp: "2026-01-01T00:00:00.000Z",
      metadata: { ...context, schemaVersion: 1, system: true },
    });
    expect(SCHEDULED_COMMAND_FAILED_EVENT).toBe("ScheduledCommandFailed");
  });

  it("lets a stream that moved fail, for the unit of work to run again", async () => {
    const { storage, append } = await setup();
    let appends = 0;
    storage.eventStore.append = async () => {
      appends += 1;
      throw new ConcurrencyError({ streamId: "order:o-1", expectedVersion: 0, actualVersion: 1 });
    };
    await expect(append()).rejects.toBeInstanceOf(ConcurrencyError);
    expect(appends).toBe(1);
  });

  it("reads only the version of the stream, not its events", async () => {
    const { storage, append } = await setup();
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-1",
      expectedVersion: 0,
      events: [pendingEvent({ aggregateId: "o-1", version: 1 })],
    });
    const load = storage.eventStore.load.bind(storage.eventStore);
    const loaded: number[] = [];
    storage.eventStore.load = async (args) => {
      const result = await load(args);
      loaded.push(result.events.length);
      return result;
    };
    await expect(append()).resolves.toMatchObject({ version: 2 });
    expect(loaded).toEqual([0]);
  });
});
