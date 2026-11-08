import { describe, expect, it } from "vitest";
import { testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { memory } from "../../memory/index.ts";
import { HOLD_MS } from "../personal-data/hold.ts";
import { createRecordingLogger } from "../test-support.ts";
import { createDeadLetterRetention, DEAD_LETTER_PURGE_LIMIT } from "./retention.ts";

const DAY = 86_400_000;
const start = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number): Date => new Date(start.getTime() + ms);

const setUp = async () => {
  const { deadLetterStore: store } = await memory().createStorage();
  const { logger, entries: logs } = createRecordingLogger();
  const retention = createDeadLetterRetention({ store, retentionMs: 7 * DAY, logger });
  const resolve = async (id: string, at: Date, status: "retried" | "discarded" = "retried") => {
    await store.add(testDeadLetter(id));
    await store.updateStatus(id, status, at);
  };
  return { store, logs, retention, resolve };
};

describe("the retention of dead letters", () => {
  it("names no time and purges nothing while no letter is resolved", async () => {
    const { store, retention } = await setUp();
    await store.add(testDeadLetter("failed"));
    expect(await retention.nextDueAt()).toBeNull();
    expect(await retention.sweep(later(365 * DAY))).toBe(0);
    expect(await store.get("failed")).not.toBeNull();
  });

  it("purges a resolved letter once the retention has passed since it was resolved", async () => {
    const { store, logs, retention, resolve } = await setUp();
    await resolve("retried", later(DAY));
    await resolve("discarded", later(2 * DAY), "discarded");
    expect(await retention.nextDueAt()).toEqual(later(8 * DAY));
    expect(await retention.sweep(later(8 * DAY - 1))).toBe(0);
    expect(await retention.sweep(later(8 * DAY))).toBe(1);
    expect(await store.get("retried")).toBeNull();
    expect(logs).toContainEqual({
      level: "info",
      message: "resolved dead letters purged",
      fields: { purged: 1 },
    });
    expect(await retention.nextDueAt()).toEqual(later(9 * DAY));
    expect(await retention.sweep(later(30 * DAY))).toBe(1);
    expect(await retention.nextDueAt()).toBeNull();
  });

  it("purges at most a batch a pass, and leaves the rest due", async () => {
    const { store, retention, resolve } = await setUp();
    for (let at = 0; at <= DEAD_LETTER_PURGE_LIMIT; at += 1) await resolve(`l-${at}`, later(at));
    expect(await retention.sweep(later(8 * DAY))).toBe(DEAD_LETTER_PURGE_LIMIT);
    expect(await store.count()).toBe(1);
    expect(await retention.nextDueAt()).toEqual(later(7 * DAY + DEAD_LETTER_PURGE_LIMIT));
  });

  it("writes nothing on a pass with nothing due", async () => {
    const { store, retention, resolve } = await setUp();
    await resolve("recent", start);
    const purge = store.purge;
    let purges = 0;
    store.purge = (args) => {
      purges += 1;
      return purge(args);
    };
    await retention.sweep(later(DAY));
    expect(purges).toBe(0);
  });

  it("logs a store that fails, waits before trying again, and names that wait as when it is due", async () => {
    const { store, logs, retention, resolve } = await setUp();
    await resolve("old", start);
    const purge = store.purge;
    let failures = 1;
    store.purge = (args) => {
      if (failures === 0) return purge(args);
      failures -= 1;
      return Promise.reject(new Error("database is down"));
    };
    const due = later(7 * DAY);
    expect(await retention.sweep(due)).toBe(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "resolved dead letters could not be purged",
        fields: expect.objectContaining({ message: "database is down" }),
      }),
    );
    expect(await retention.nextDueAt()).toEqual(new Date(due.getTime() + HOLD_MS));
    expect(await retention.sweep(new Date(due.getTime() + HOLD_MS - 1))).toBe(0);
    expect(await retention.sweep(new Date(due.getTime() + HOLD_MS))).toBe(1);
    expect(await retention.nextDueAt()).toBeNull();
  });
});
