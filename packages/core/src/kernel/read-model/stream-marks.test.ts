import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../contracts/event.ts";
import { createMemoryCheckpointStore } from "../../memory/checkpoint-store.ts";
import { eventMark, markedCompareAndSet, reachedOf, streamMarkOf } from "./stream-marks.ts";

const eventAt = (position: number, id: string) => ({ position, id }) as unknown as StoredEvent;

describe("eventMark", () => {
  it("is the same for the same id, apart for others, and held exactly by a number", () => {
    const id = "019a6b1e-0000-7000-8000-000000000001";
    expect(eventMark(id)).toBe(eventMark(id));
    expect(eventMark(id)).not.toBe(eventMark("019a6b1e-0000-7000-8000-000000000002"));
    for (const candidate of [id, "", "x", "é"]) {
      const mark = eventMark(candidate);
      expect(Number.isSafeInteger(mark)).toBe(true);
      expect(mark).toBeGreaterThanOrEqual(0);
      expect(mark).toBeLessThan(2 ** 52);
    }
  });

  it("is 52 bits of the 64-bit FNV-1a of the id", () => {
    // FNV-1a 64 of "" is its offset basis, cbf29ce484222325; of "a", af63dc4c8601ec8c.
    expect(eventMark("")).toBe(0x29ce484222325);
    expect(eventMark("a")).toBe(0x3dc4c8601ec8c);
  });
});

describe("the rows beside a subscriber's checkpoint", () => {
  it("are named after it", () => {
    expect(streamMarkOf("projection:orders")).toBe("restore:event:projection:orders");
    expect(reachedOf("projection:orders")).toBe("restore:reached:projection:orders");
  });
});

describe("markedCompareAndSet", () => {
  it("marks the event the checkpoint moved to, in the same store", async () => {
    const checkpoints = createMemoryCheckpointStore();
    const move = markedCompareAndSet({
      checkpoints,
      subscriber: "projection:orders",
      events: [eventAt(4, "a"), eventAt(7, "b")],
    });
    expect(await move(0, 7)).toBe(true);
    expect(await checkpoints.get("projection:orders")).toBe(7);
    expect(await checkpoints.get(streamMarkOf("projection:orders"))).toBe(eventMark("b"));
  });

  it("marks nothing when the checkpoint moved elsewhere", async () => {
    const checkpoints = createMemoryCheckpointStore();
    await checkpoints.set("projection:orders", 2);
    const move = markedCompareAndSet({
      checkpoints,
      subscriber: "projection:orders",
      events: [eventAt(4, "a")],
    });
    expect(await move(0, 4)).toBe(false);
    expect(await checkpoints.list()).toEqual([{ subscriber: "projection:orders", position: 2 }]);
  });

  it("marks nothing for a position no event of the batch holds", async () => {
    const checkpoints = createMemoryCheckpointStore();
    const move = markedCompareAndSet({
      checkpoints,
      subscriber: "projection:orders",
      events: [eventAt(4, "a")],
    });
    expect(await move(0, 5)).toBe(true);
    expect(await checkpoints.list()).toEqual([{ subscriber: "projection:orders", position: 5 }]);
  });
});
