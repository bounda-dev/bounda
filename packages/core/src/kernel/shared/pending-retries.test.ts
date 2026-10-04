import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { createPendingRetries, ignoredRetries } from "./pending-retries.ts";

const at = (iso: string): Date => new Date(`2026-01-01T${iso}Z`);
const nothingScheduled = async (): Promise<Date | null> => null;

describe("createPendingRetries", () => {
  it("moves the clock to the earliest retry to come, one at a time", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.waiting(at("00:00:04.000"));
    retries.waiting(at("00:00:01.000"));
    retries.waiting(at("00:00:01.000"));
    expect(await retries.skipToNext(nothingScheduled)).toBe(true);
    expect(clock.now()).toEqual(at("00:00:01.000"));
    expect(await retries.skipToNext(nothingScheduled)).toBe(true);
    expect(clock.now()).toEqual(at("00:00:04.000"));
    expect(await retries.skipToNext(nothingScheduled)).toBe(false);
    expect(clock.now()).toEqual(at("00:00:04.000"));
  });

  it("drops a retry whose time the clock has reached", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.waiting(at("00:00:01.000"));
    retries.waiting(at("00:00:02.000"));
    clock.advance(2_000);
    expect(await retries.skipToNext(nothingScheduled)).toBe(false);
    expect(clock.now()).toEqual(at("00:00:02.000"));
  });

  it("asks for another round, without moving the clock, for a retry due at once", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.waiting(at("00:00:00.000"));
    expect(await retries.skipToNext(nothingScheduled)).toBe(true);
    expect(clock.now()).toEqual(at("00:00:00.000"));
    expect(await retries.skipToNext(nothingScheduled)).toBe(false);
  });

  it("stops first at what is scheduled before the retry, and only then", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.waiting(at("00:00:04.000"));
    expect(await retries.skipToNext(async () => at("00:00:02.000"))).toBe(true);
    expect(clock.now()).toEqual(at("00:00:02.000"));
    expect(await retries.skipToNext(async () => at("00:00:02.000"))).toBe(true);
    expect(clock.now()).toEqual(at("00:00:04.000"));
    retries.waiting(at("00:00:06.000"));
    expect(await retries.skipToNext(async () => at("00:00:06.000"))).toBe(true);
    expect(clock.now()).toEqual(at("00:00:06.000"));
  });

  it("never asks what is scheduled when no retry is waiting", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    let asked = false;
    const scheduled = async (): Promise<Date | null> => {
      asked = true;
      return at("00:00:02.000");
    };
    expect(await retries.skipToNext(scheduled)).toBe(false);
    expect(asked).toBe(false);
    expect(clock.now()).toEqual(at("00:00:00.000"));
  });

  it("never moves anything when ignored", async () => {
    ignoredRetries.waiting(at("00:00:01.000"));
    expect(await ignoredRetries.skipToNext(async () => at("00:00:01.000"))).toBe(false);
  });
});
