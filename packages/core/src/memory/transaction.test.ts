import { describe, expect, it } from "vitest";
import { createMemoryCheckpointStore } from "./checkpoint-store.ts";
import { createCheckpointJournal, createMemoryLocks } from "./transaction.ts";

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
