import { describe, expect, it } from "vitest";
import { nextWake } from "../src/wake.ts";

const base = {
  idle: true,
  settled: false,
  lag: 0,
  rebuild: "none",
  due: null,
  now: 1_000,
  retryMs: 5_000,
} as const;

describe("nextWake", () => {
  it("sleeps when nothing is pending", () => {
    expect(nextWake(base)).toBeNull();
  });

  it("wakes at once for work left over or for new events", () => {
    expect(nextWake({ ...base, idle: false })).toBe(1_000);
    expect(nextWake({ ...base, lag: 3 })).toBe(1_000);
  });

  it("waits the retry interval for events a retry is holding after an alarm", () => {
    expect(nextWake({ ...base, lag: 3, settled: true })).toBe(6_000);
    expect(nextWake({ ...base, lag: 3, settled: true, idle: false })).toBe(1_000);
  });

  it("wakes at once for a rebuild's next slice, and after the retry interval when one failed", () => {
    expect(nextWake({ ...base, rebuild: "next" })).toBe(1_000);
    expect(nextWake({ ...base, rebuild: "held", settled: true })).toBe(6_000);
    expect(nextWake({ ...base, rebuild: "held", due: new Date(2_000) })).toBe(2_000);
  });

  it("wakes for scheduled work at its time, never in the past, whichever comes first", () => {
    expect(nextWake({ ...base, due: new Date(9_000) })).toBe(9_000);
    expect(nextWake({ ...base, due: new Date(10) })).toBe(1_000);
    expect(nextWake({ ...base, due: new Date(3_000), lag: 1, settled: true })).toBe(3_000);
    expect(nextWake({ ...base, due: new Date(9_000), lag: 1, settled: true })).toBe(6_000);
  });
});
