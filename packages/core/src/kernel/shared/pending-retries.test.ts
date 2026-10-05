import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { createPendingRetries, ignoredRetries } from "./pending-retries.ts";

const at = (iso: string): Date => new Date(`2026-01-01T${iso}Z`);
const nothing = async (): Promise<Date | null> => null;
const answering = (date: Date) => async (): Promise<Date | null> => date;

describe("createPendingRetries", () => {
  it("moves the clock to the earliest retry reported in the round", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.startRound();
    retries.waiting(at("00:00:04.000"));
    retries.waiting(at("00:00:01.000"));
    retries.waiting(at("00:00:01.000"));
    expect(await retries.skipToNext(nothing, nothing)).toBe(true);
    expect(clock.now()).toEqual(at("00:00:01.000"));
    retries.startRound();
    retries.waiting(at("00:00:04.000"));
    expect(await retries.skipToNext(nothing, nothing)).toBe(true);
    expect(clock.now()).toEqual(at("00:00:04.000"));
  });

  it("forgets at the start of a round a retry that is not reported again", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.startRound();
    retries.waiting(at("00:00:04.000"));
    retries.startRound();
    expect(await retries.skipToNext(nothing, nothing)).toBe(false);
    expect(clock.now()).toEqual(at("00:00:00.000"));
  });

  it("asks for another round, without moving the clock, for a retry due at once", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.startRound();
    retries.waiting(at("00:00:00.000"));
    expect(await retries.skipToNext(nothing, nothing)).toBe(true);
    expect(clock.now()).toEqual(at("00:00:00.000"));
    retries.startRound();
    expect(await retries.skipToNext(nothing, nothing)).toBe(false);
  });

  it("stops first at what is scheduled before the retry, and only then", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.startRound();
    retries.waiting(at("00:00:04.000"));
    expect(await retries.skipToNext(answering(at("00:00:02.000")), nothing)).toBe(true);
    expect(clock.now()).toEqual(at("00:00:02.000"));
    retries.startRound();
    retries.waiting(at("00:00:04.000"));
    expect(await retries.skipToNext(answering(at("00:00:02.000")), nothing)).toBe(true);
    expect(clock.now()).toEqual(at("00:00:04.000"));
    retries.startRound();
    retries.waiting(at("00:00:06.000"));
    expect(await retries.skipToNext(answering(at("00:00:06.000")), nothing)).toBe(true);
    expect(clock.now()).toEqual(at("00:00:06.000"));
  });

  it("takes a scheduled command's retry from what is stored, if it is still to come", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    retries.startRound();
    retries.waiting(at("00:00:05.000"));
    expect(await retries.skipToNext(nothing, answering(at("00:00:03.000")))).toBe(true);
    expect(clock.now()).toEqual(at("00:00:03.000"));
    retries.startRound();
    expect(await retries.skipToNext(nothing, answering(at("00:00:03.000")))).toBe(false);
    expect(clock.now()).toEqual(at("00:00:03.000"));
  });

  it("never asks what is scheduled when no retry is waiting", async () => {
    const clock = createFixedClock();
    const retries = createPendingRetries(clock);
    let asked = false;
    const scheduled = async (): Promise<Date | null> => {
      asked = true;
      return at("00:00:02.000");
    };
    retries.startRound();
    expect(await retries.skipToNext(scheduled, nothing)).toBe(false);
    expect(asked).toBe(false);
    expect(clock.now()).toEqual(at("00:00:00.000"));
  });

  it("never moves anything when ignored", async () => {
    ignoredRetries.startRound();
    ignoredRetries.waiting(at("00:00:01.000"));
    expect(
      await ignoredRetries.skipToNext(answering(at("00:00:01.000")), answering(at("00:00:01.000"))),
    ).toBe(false);
  });
});
