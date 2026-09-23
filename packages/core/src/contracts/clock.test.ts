import { describe, expect, it, vi } from "vitest";
import { createFixedClock, systemClock } from "./clock.ts";

describe("systemClock", () => {
  it("returns the current time", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("waits on the platform's timers, and cancels them", () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      systemClock.after(100, () => calls.push("kept"));
      const cancel = systemClock.after(100, () => calls.push("cancelled"));
      cancel();
      vi.advanceTimersByTime(99);
      expect(calls).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(calls).toEqual(["kept"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createFixedClock", () => {
  it("stays still until moved", () => {
    const clock = createFixedClock(new Date("2026-03-01T10:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-03-01T10:00:00.000Z");
  });

  it("advances by milliseconds and jumps to a date", () => {
    const clock = createFixedClock(new Date("2026-03-01T10:00:00.000Z"));
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe("2026-03-01T10:01:30.000Z");
    clock.set(new Date("2027-01-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("has a default start", () => {
    expect(createFixedClock().now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("fires a call only once it has moved past it, reading the time the call was due at", () => {
    const clock = createFixedClock(new Date("2026-03-01T10:00:00.000Z"));
    const fired: string[] = [];
    clock.after(1_000, () => fired.push(clock.now().toISOString()));
    clock.advance(999);
    expect(fired).toEqual([]);
    clock.advance(5_000);
    expect(fired).toEqual(["2026-03-01T10:00:01.000Z"]);
    expect(clock.now().toISOString()).toBe("2026-03-01T10:00:05.999Z");
    clock.advance(10_000);
    expect(fired).toHaveLength(1);
  });

  it("fires the calls due on the way in the order they fall due, ties in the order made", () => {
    const clock = createFixedClock();
    const fired: string[] = [];
    clock.after(300, () => fired.push("c"));
    clock.after(100, () => fired.push("a"));
    clock.after(100, () => fired.push("b"));
    clock.after(0, () => fired.push("now"));
    clock.advance(300);
    expect(fired).toEqual(["now", "a", "b", "c"]);
  });

  it("fires a call made by another call when it falls due within the same move", () => {
    const clock = createFixedClock();
    const fired: number[] = [];
    const every = (milliseconds: number) =>
      clock.after(milliseconds, () => {
        fired.push(clock.now().getTime() - createFixedClock().now().getTime());
        every(milliseconds);
      });
    every(100);
    clock.advance(350);
    expect(fired).toEqual([100, 200, 300]);
  });

  it("does not fire a cancelled call", () => {
    const clock = createFixedClock();
    const fired: string[] = [];
    const cancel = clock.after(10, () => fired.push("cancelled"));
    clock.after(10, () => fired.push("kept"));
    cancel();
    cancel();
    clock.advance(10);
    expect(fired).toEqual(["kept"]);
  });

  it("counts the calls waiting to fire", () => {
    const clock = createFixedClock();
    expect(clock.pending()).toBe(0);
    const cancel = clock.after(10, () => undefined);
    clock.after(20, () => undefined);
    expect(clock.pending()).toBe(2);
    cancel();
    expect(clock.pending()).toBe(1);
    clock.advance(20);
    expect(clock.pending()).toBe(0);
  });

  it("fires on the way when set forward, and keeps calls pending when set back", () => {
    const clock = createFixedClock(new Date("2026-03-01T10:00:00.000Z"));
    const fired: string[] = [];
    clock.after(60_000, () => fired.push(clock.now().toISOString()));
    clock.set(new Date("2026-03-01T09:00:00.000Z"));
    expect(fired).toEqual([]);
    clock.set(new Date("2026-03-01T10:00:59.999Z"));
    expect(fired).toEqual([]);
    clock.set(new Date("2026-03-01T11:00:00.000Z"));
    expect(fired).toEqual(["2026-03-01T10:01:00.000Z"]);
  });
});
