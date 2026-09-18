import { describe, expect, it } from "vitest";
import { createFixedClock, systemClock } from "./clock.ts";

describe("systemClock", () => {
  it("returns the current time", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
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
});
