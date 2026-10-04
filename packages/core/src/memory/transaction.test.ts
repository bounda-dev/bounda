import { describe, expect, it } from "vitest";
import type { StorageTransaction } from "../adapter/adapter.ts";
import { testCommand, testContext, testDeadLetter } from "../adapter/testing/fixtures.ts";
import { ScheduledClaimLostError } from "../contracts/errors.ts";
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
  const storage = () => memory().createStorage({ logger: silentLogger });
  // Refused when the transaction commits: nobody handed out this claim.
  const refused = (tx: StorageTransaction) =>
    tx.scheduler.complete({ dedupeKey: "unclaimed", revision: 0, claimId: "lost" });

  it("puts back every entry it changed, newest first, when a later write fails", async () => {
    const ports = await storage();
    await ports.scheduler.schedule(schedule("kept", 1));
    await ports.scheduler.schedule(schedule("cancelled", 2));
    const before = await ports.scheduler.list();
    await expect(
      ports.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("kept", 3));
        await tx.scheduler.schedule(schedule("kept", 4));
        await tx.scheduler.cancel("cancelled");
        await tx.scheduler.schedule(schedule("new", 5));
        await refused(tx);
      }),
    ).rejects.toBeInstanceOf(ScheduledClaimLostError);
    expect(await ports.scheduler.list()).toEqual(before);
  });

  it("leaves an entry alone that someone changed after its write", async () => {
    const ports = await storage();
    const live = ports.scheduler.schedule;
    ports.scheduler.schedule = async (args) => {
      const written = live(args);
      if (args.dedupeKey === "after") await live(schedule("k", 9));
      return written;
    };
    await expect(
      ports.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("k", 1));
        await tx.scheduler.schedule(schedule("after", 2));
        await refused(tx);
      }),
    ).rejects.toBeInstanceOf(ScheduledClaimLostError);
    expect(await ports.scheduler.list()).toMatchObject([
      { dedupeKey: "k", executeAt: at(9).toISOString() },
    ]);
  });

  it("reads what its write changed before anyone else can write the entry", async () => {
    const ports = await storage();
    const live = ports.scheduler.schedule;
    ports.scheduler.schedule = async (args) => {
      const written = live(args);
      if (args.executeAt.getTime() === at(1).getTime()) {
        queueMicrotask(() => void live(schedule("k", 9)));
      }
      return written;
    };
    await expect(
      ports.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("k", 1));
        await refused(tx);
      }),
    ).rejects.toBeInstanceOf(ScheduledClaimLostError);
    expect(await ports.scheduler.list()).toMatchObject([
      { dedupeKey: "k", executeAt: at(9).toISOString() },
    ]);
  });

  it("puts back nothing for a write that changed nothing", async () => {
    const ports = await storage();
    const live = ports.scheduler.cancel;
    ports.scheduler.cancel = async (dedupeKey) => {
      const written = live(dedupeKey);
      queueMicrotask(() => void ports.scheduler.schedule(schedule(dedupeKey, 9)));
      return written;
    };
    await expect(
      ports.transact(async (tx) => {
        await tx.scheduler.cancel("k");
        await refused(tx);
      }),
    ).rejects.toBeInstanceOf(ScheduledClaimLostError);
    expect(await ports.scheduler.list()).toMatchObject([
      { dedupeKey: "k", executeAt: at(9).toISOString() },
    ]);
  });

  it("keeps what a concurrent transaction committed over the same entry when it fails", async () => {
    const ports = await storage();
    const outcomes = await Promise.allSettled([
      ports.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("k", 1));
        await refused(tx);
      }),
      ports.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("k", 2));
        await tx.scheduler.schedule(schedule("other", 3));
      }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
    expect(await ports.scheduler.list()).toMatchObject([
      { dedupeKey: "k", executeAt: at(2).toISOString() },
      { dedupeKey: "other" },
    ]);
  });

  it("commits one at a time, so a transaction never sees what another may still put back", async () => {
    const ports = await storage();
    await ports.deadLetterStore.add(testDeadLetter("d1"));
    let discard: Promise<void> | undefined;
    const live = ports.scheduler.cancel;
    ports.scheduler.cancel = async (dedupeKey) => {
      discard ??= ports.transact(async (tx) => {
        await tx.deadLetterStore.updateStatus("d1", "discarded");
      });
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
      return live(dedupeKey);
    };
    await expect(
      ports.transact(async (tx) => {
        await tx.deadLetterStore.updateStatus("d1", "replayed");
        await tx.scheduler.cancel("a");
        await refused(tx);
      }),
    ).rejects.toBeInstanceOf(ScheduledClaimLostError);
    await discard;
    expect((await ports.deadLetterStore.get("d1"))?.status).toBe("discarded");
  });

  it("leaves nothing of two concurrent transactions over the same entry that both fail", async () => {
    const ports = await storage();
    const failing = (minutes: number) =>
      ports.transact(async (tx) => {
        await tx.scheduler.schedule(schedule("k", minutes));
        await refused(tx);
      });
    const outcomes = await Promise.allSettled([failing(1), failing(2)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(await ports.scheduler.list()).toEqual([]);
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
