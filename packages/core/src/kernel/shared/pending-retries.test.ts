import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { createPendingRetries, ignoredRetries } from "./pending-retries.ts";

const at = (iso: string): Date => new Date(`2026-01-01T${iso}Z`);

describe("createPendingRetries", () => {
  it("moves the clock to the earliest retry to come, one at a time", () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.waiting(at("00:00:04.000"));
    retries.waiting(at("00:00:01.000"));
    retries.waiting(at("00:00:01.000"));
    expect(retries.skipToNext()).toBe(true);
    expect(clock.now()).toEqual(at("00:00:01.000"));
    expect(retries.skipToNext()).toBe(true);
    expect(clock.now()).toEqual(at("00:00:04.000"));
    expect(retries.skipToNext()).toBe(false);
    expect(clock.now()).toEqual(at("00:00:04.000"));
  });

  it("drops a retry whose time the clock has reached", () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.waiting(at("00:00:01.000"));
    retries.waiting(at("00:00:02.000"));
    clock.advance(2_000);
    expect(retries.skipToNext()).toBe(false);
    expect(clock.now()).toEqual(at("00:00:02.000"));
  });

  it("never moves anything when ignored", () => {
    ignoredRetries.waiting(at("00:00:01.000"));
    expect(ignoredRetries.skipToNext()).toBe(false);
  });
});
