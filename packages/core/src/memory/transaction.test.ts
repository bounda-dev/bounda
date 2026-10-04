import { describe, expect, it } from "vitest";
import type { StorageTransaction } from "../adapter/adapter.ts";
import { testCommand, testContext } from "../adapter/testing/fixtures.ts";
import { DeadLetterSettledError } from "../contracts/errors.ts";
import { silentLogger } from "../contracts/logger.ts";
import { createMemoryCheckpointStore } from "./checkpoint-store.ts";
import { memory } from "./index.ts";
import { createCheckpointJournal, createMemoryLocks } from "./transaction.ts";

describe("createMemoryStorageTransaction", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
  const schedule = (dedupeKey: string, minutes: number) => ({
    dedupeKey,
    command: testCommand("1"),
    executeAt: at(minutes),
    context: testContext,
  });
  const withSettledLetter = async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    await storage.deadLetterStore.add({
      id: "settled",
      kind: "policy",
      subscriber: "order.p",
      eventId: "e1",
      eventType: "OrderPlaced",
      aggregateType: "order",
      aggregateId: "1",
      errorType: "terminal",
      errorMessage: "boom",
      attempts: 1,
      firstFailedAt: at(0).toISOString(),
      lastFailedAt: at(0).toISOString(),
    });
    await storage.deadLetterStore.updateStatus("settled", "discarded");
    return storage;
  };
  const refused = (tx: StorageTransaction) =>
    tx.deadLetterStore.updateStatus("settled", "replayed");

  it("undoes its own writes when a later one fails", async () => {
    const storage = await withSettledLetter();
    await storage.scheduler.schedule(schedule("kept", 1));
    await storage.scheduler.schedule(schedule("cancelled", 2));
    const before = await storage.scheduler.list();
    await expect(
      storage.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("kept", 3));
        await tx.scheduler.schedule(schedule("kept", 4));
        await tx.scheduler.cancel("cancelled");
        await tx.scheduler.schedule(schedule("new", 5));
        await refused(tx);
      }),
    ).rejects.toBeInstanceOf(DeadLetterSettledError);
    expect(await storage.scheduler.list()).toEqual(before);
    expect((await storage.deadLetterStore.get("settled"))?.status).toBe("discarded");
  });

  it("keeps what a concurrent transaction wrote over the same entry when it rolls back", async () => {
    const storage = await withSettledLetter();
    const outcomes = await Promise.allSettled([
      storage.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("k", 1));
        await refused(tx);
      }),
      storage.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("k", 2));
      }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
    expect(await storage.scheduler.list()).toMatchObject([{ executeAt: at(2).toISOString() }]);
  });

  it("leaves nothing of two concurrent transactions over the same entry that both roll back", async () => {
    const storage = await withSettledLetter();
    const failing = (minutes: number) =>
      storage.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("k", minutes));
        await refused(tx);
      });
    const outcomes = await Promise.allSettled([failing(1), failing(2)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(await storage.scheduler.list()).toEqual([]);
  });
});

describe("createMemoryLocks", () => {
  it("hands a lock to the next waiter and keeps it closed to anyone who will not wait", async () => {
    const locks = createMemoryLocks();
    const first = await locks.acquire("a", false);
    const next = locks.acquire("a", true);
    expect(await locks.acquire("a", false)).toBeUndefined();
    expect(await locks.acquire("b", false)).toBeTypeOf("function");
    first?.();
    const second = await next;
    expect(await locks.acquire("a", false)).toBeUndefined();
    second?.();
    const third = await locks.acquire("a", false);
    expect(third).toBeTypeOf("function");
    third?.();
  });

  it("grants the lock to its waiters in the order they asked for it", async () => {
    const locks = createMemoryLocks();
    const granted: string[] = [];
    const first = await locks.acquire("a", true);
    const waiters = ["second", "third", "fourth"].map(async (name) => {
      const release = await locks.acquire("a", true);
      granted.push(name);
      release?.();
    });
    first?.();
    await Promise.all(waiters);
    expect(granted).toEqual(["second", "third", "fourth"]);
  });
});

describe("createCheckpointJournal", () => {
  it("undoes every change it made, newest first, and nothing it did not make", async () => {
    const base = createMemoryCheckpointStore();
    await base.set("a", 3);
    await base.set("gone", 4);
    await base.set("other", 5);
    const journal = createCheckpointJournal(base);
    await journal.store.set("a", 5);
    expect(await journal.store.compareAndSet("a", 5, 7)).toBe(true);
    expect(await journal.store.compareAndSet("other", 1, 9)).toBe(false);
    await journal.store.remove("gone");
    await journal.store.set("fresh", 2);
    expect(await journal.store.get("a")).toBe(7);
    expect(await journal.store.get("gone")).toBe(0);
    expect(await journal.store.list()).toEqual(await base.list());
    await journal.undo();
    expect(await base.list()).toEqual(
      expect.arrayContaining([
        { subscriber: "a", position: 3 },
        { subscriber: "gone", position: 4 },
        { subscriber: "other", position: 5 },
      ]),
    );
    expect(await base.get("fresh")).toBe(0);
  });

  it("leaves a checkpoint someone else moved after the change alone", async () => {
    const base = createMemoryCheckpointStore();
    const journal = createCheckpointJournal(base);
    await journal.store.set("a", 5);
    await base.set("a", 8);
    await journal.undo();
    expect(await base.get("a")).toBe(8);
  });
});
