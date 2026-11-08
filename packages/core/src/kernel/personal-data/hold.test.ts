import { describe, expect, it } from "vitest";
import { createPause, HOLD_MAX_MS, HOLD_MS, holdAfter } from "./hold.ts";

describe("holdAfter", () => {
  it("waits HOLD_MS after a first failure, twice as long after each one more, up to HOLD_MAX_MS", () => {
    const first = holdAfter({ held: null, at: 0, failed: true });
    expect(first).toEqual({ until: new Date(HOLD_MS).toISOString(), attempts: 1 });
    expect(holdAfter({ held: first, at: 0, failed: true })).toEqual({
      until: new Date(2 * HOLD_MS).toISOString(),
      attempts: 2,
    });
    expect(holdAfter({ held: { until: "", attempts: 20 }, at: 0, failed: true })).toEqual({
      until: new Date(HOLD_MAX_MS).toISOString(),
      attempts: 21,
    });
  });

  it("waits as long as the last time for a row left for later without failing", () => {
    expect(holdAfter({ held: null, at: 0, failed: false })).toEqual({
      until: new Date(HOLD_MS).toISOString(),
      attempts: 0,
    });
    expect(holdAfter({ held: { until: "", attempts: 2 }, at: 0, failed: false })).toEqual({
      until: new Date(2 * HOLD_MS).toISOString(),
      attempts: 2,
    });
  });
});

describe("createPause", () => {
  it("settles a pass: pausing longer after each one the store failed, and resuming after one it kept", () => {
    const pause = createPause();
    expect(pause.isPaused(0)).toBe(false);
    expect(pause.notBefore(5)).toBe(5);
    pause.settle(0, false);
    expect(pause.isPaused(HOLD_MS - 1)).toBe(true);
    expect(pause.isPaused(HOLD_MS)).toBe(false);
    expect(pause.notBefore(5)).toBe(HOLD_MS);
    pause.settle(HOLD_MS, false);
    expect(pause.notBefore(0)).toBe(3 * HOLD_MS);
    pause.settle(3 * HOLD_MS, true);
    expect(pause.isPaused(3 * HOLD_MS)).toBe(false);
    pause.settle(3 * HOLD_MS, false);
    expect(pause.notBefore(0)).toBe(4 * HOLD_MS);
  });
});
