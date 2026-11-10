import { describe, expect, it } from "vitest";
import { testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { HOLD_MS } from "../personal-data/hold.ts";
import { LEASE_MS } from "../shared/lease.ts";
import { createRecordingLogger } from "../test-support.ts";
import {
  createDeadLetterRetention,
  DEAD_LETTER_PURGE_LEASE,
  DEAD_LETTER_PURGE_LIMIT,
} from "./retention.ts";

const DAY = 86_400_000;
const start = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number): Date => new Date(start.getTime() + ms);

const setUp = async () => {
  const { deadLetterStore: store, checkpointStore: checkpoints } = await memory().createStorage();
  const { logger, entries: logs } = createRecordingLogger();
  const retention = createDeadLetterRetention({
    store,
    checkpoints,
    retentionMs: 7 * DAY,
    clock: createFixedClock(start),
    logger,
  });
  const resolve = async (id: string, at: Date, status: "retried" | "discarded" = "retried") => {
    await store.add(testDeadLetter(id));
    await store.updateStatus(id, status, at);
  };
  // Another instance over the same store.
  const other = () =>
    createDeadLetterRetention({
      store,
      checkpoints,
      retentionMs: 7 * DAY,
      clock: createFixedClock(start),
      logger,
    });
  return { store, checkpoints, logs, retention, resolve, other };
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
      level: "debug",
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

  it("writes and logs nothing on a pass with nothing due", async () => {
    const { store, logs, retention, resolve } = await setUp();
    const purge = store.purge;
    let purges = 0;
    store.purge = (args) => {
      purges += 1;
      return purge(args);
    };
    await retention.sweep(later(DAY));
    await resolve("recent", start);
    await retention.sweep(later(DAY));
    expect(purges).toBe(0);
    expect(logs).toEqual([]);
  });

  it("reads the store again only once a letter can be due", async () => {
    const { store, retention, resolve } = await setUp();
    const firstResolvedAt = store.firstResolvedAt;
    let reads = 0;
    store.firstResolvedAt = () => {
      reads += 1;
      return firstResolvedAt();
    };
    await retention.sweep(start);
    await resolve("a", later(DAY));
    await retention.sweep(later(7 * DAY - 1));
    expect(reads).toBe(1);
    expect(await retention.sweep(later(7 * DAY))).toBe(0);
    expect(reads).toBe(2);
    await retention.sweep(later(8 * DAY - 1));
    expect(reads).toBe(2);
    expect(await retention.sweep(later(8 * DAY))).toBe(1);
    expect(await retention.sweep(later(8 * DAY))).toBe(0);
    expect(reads).toBe(4);
  });

  it("waits as long as the first time again once a pass reads the store", async () => {
    const { store, retention } = await setUp();
    const firstResolvedAt = store.firstResolvedAt;
    let failing = true;
    store.firstResolvedAt = () =>
      failing ? Promise.reject(new Error("database is down")) : firstResolvedAt();
    expect(await retention.sweep(start)).toBe(0);
    failing = false;
    expect(await retention.sweep(later(HOLD_MS))).toBe(0);
    failing = true;
    const again = later(HOLD_MS + 7 * DAY);
    expect(await retention.sweep(again)).toBe(0);
    failing = false;
    expect(await retention.nextDueAt()).toBeNull();
    store.firstResolvedAt = async () => new Date(0);
    expect(await retention.nextDueAt()).toEqual(new Date(again.getTime() + HOLD_MS));
  });

  it("logs a store that fails, waits before trying again, and names that wait as when it is due", async () => {
    const { store, logs, retention, resolve } = await setUp();
    await resolve("old", start);
    const purge = store.purge;
    let failures = 2;
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
        fields: expect.objectContaining({ errorMessage: "database is down" }),
      }),
    );
    expect(await retention.nextDueAt()).toEqual(new Date(due.getTime() + HOLD_MS));
    expect(await retention.sweep(new Date(due.getTime() + HOLD_MS - 1))).toBe(0);
    const resumed = due.getTime() + HOLD_MS;
    expect(await retention.sweep(new Date(resumed))).toBe(0);
    expect(await retention.nextDueAt()).toEqual(new Date(resumed + 2 * HOLD_MS));
    expect(await retention.sweep(new Date(resumed + 2 * HOLD_MS))).toBe(1);
    expect(await retention.nextDueAt()).toBeNull();
    await resolve("next", new Date(resumed));
    failures = 1;
    const next = resumed + 7 * DAY;
    expect(await retention.sweep(new Date(next))).toBe(0);
    expect(await retention.nextDueAt()).toEqual(new Date(next + HOLD_MS));
  });
});

describe("the retention of dead letters across instances", () => {
  it("purges each batch once while two instances run it: the one holding the lease", async () => {
    const { store, checkpoints, retention, resolve, other } = await setUp();
    for (let at = 0; at <= DEAD_LETTER_PURGE_LIMIT; at += 1) await resolve(`l-${at}`, later(at));
    const second = other();
    const due = later(8 * DAY);
    expect(await retention.sweep(due)).toBe(DEAD_LETTER_PURGE_LIMIT);
    expect(await second.sweep(due)).toBe(0);
    expect(await store.count()).toBe(1);
    expect(await checkpoints.get(DEAD_LETTER_PURGE_LEASE)).toBe(due.getTime() + LEASE_MS);
    expect(await second.nextDueAt()).toEqual(new Date(due.getTime() + LEASE_MS));
    await retention.release();
    expect(await second.sweep(due)).toBe(1);
  });

  it("hands the purge to another instance once its lease lapsed, and purges nothing more itself", async () => {
    const { store, retention, resolve, other } = await setUp();
    for (let at = 0; at < 2 * DEAD_LETTER_PURGE_LIMIT; at += 1) await resolve(`l-${at}`, later(at));
    const due = later(8 * DAY);
    expect(await retention.sweep(due)).toBe(DEAD_LETTER_PURGE_LIMIT);
    const lapsed = new Date(due.getTime() + LEASE_MS);
    const second = other();
    expect(await second.sweep(lapsed)).toBe(DEAD_LETTER_PURGE_LIMIT);
    await resolve("late", start);
    expect(await retention.sweep(new Date(lapsed.getTime() + 1))).toBe(0);
    expect(await store.count()).toBe(1);
  });

  it("purges again at once after a restore, though the store had paused it", async () => {
    const { store, retention, resolve } = await setUp();
    await resolve("a", later(-8 * DAY));
    const { firstResolvedAt } = store;
    store.firstResolvedAt = () => Promise.reject(new Error("down"));
    expect(await retention.sweep(start)).toBe(0);
    store.firstResolvedAt = firstResolvedAt;
    expect(await retention.sweep(start)).toBe(0);
    retention.restored();
    expect(await retention.sweep(start)).toBe(1);
  });

  it("reads the store again at once after a restore", async () => {
    const { store, retention, resolve } = await setUp();
    await retention.sweep(start);
    await resolve("a", later(-8 * DAY));
    expect(await retention.sweep(later(DAY))).toBe(0);
    retention.restored();
    expect(await retention.sweep(later(DAY))).toBe(1);
    expect(await store.count()).toBe(0);
  });

  it("says when the earliest resolved letter comes due", async () => {
    const { retention, resolve } = await setUp();
    expect(await retention.status()).toEqual({ retentionMs: 7 * DAY, nextDueAt: null });
    await resolve("a", later(DAY));
    expect(await retention.status()).toEqual({
      retentionMs: 7 * DAY,
      nextDueAt: later(8 * DAY).toISOString(),
    });
  });
});
