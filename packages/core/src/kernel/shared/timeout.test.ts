import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { HandlerTimeoutError, withTimeout } from "./timeout.ts";

const HOUR = 3_600_000;

describe("withTimeout", () => {
  it("returns the value of a handler that finishes in time", async () => {
    const clock = createFixedClock();
    await expect(withTimeout({ run: () => 42, timeoutMs: 50, subject: "x", clock })).resolves.toBe(
      42,
    );
    await expect(
      withTimeout({ run: async () => "ok", timeoutMs: 50, subject: "x", clock }),
    ).resolves.toBe("ok");
  });

  it("lets a handler finish up to the last moment before its timeout", async () => {
    const clock = createFixedClock();
    const handler = Promise.withResolvers<string>();
    const outcome = withTimeout({
      run: () => handler.promise,
      timeoutMs: HOUR,
      subject: "x",
      clock,
    });
    clock.advance(HOUR - 1);
    handler.resolve("in time");
    await expect(outcome).resolves.toBe("in time");
  });

  it("rejects with HandlerTimeoutError once the clock reaches the timeout", async () => {
    const clock = createFixedClock();
    const outcome = withTimeout({
      run: () => new Promise<never>(() => undefined),
      timeoutMs: HOUR,
      subject: "policy x",
      clock,
    });
    clock.advance(HOUR);
    const error = await outcome.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HandlerTimeoutError);
    expect((error as HandlerTimeoutError).code).toBe("HANDLER_TIMEOUT");
    expect((error as Error).message).toBe("policy x did not finish within 3600000ms");
  });

  it("propagates handler errors", async () => {
    await expect(
      withTimeout({
        run: () => Promise.reject(new Error("boom")),
        timeoutMs: 50,
        subject: "x",
        clock: createFixedClock(),
      }),
    ).rejects.toThrow("boom");
  });

  it("aborts the handler's signal with the error it loses to", async () => {
    const clock = createFixedClock();
    let signal: AbortSignal | undefined;
    const outcome = withTimeout({
      run: (given) => {
        signal = given;
        return new Promise<never>(() => undefined);
      },
      timeoutMs: HOUR,
      subject: "command x",
      clock,
    });
    expect(signal?.aborted).toBe(false);
    clock.advance(HOUR);
    const error = await outcome.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HandlerTimeoutError);
    expect(signal?.reason).toBe(error);
  });

  it("rejects with the reason of the first signal that aborts, and aborts the handler's", async () => {
    const clock = createFixedClock();
    const first = new AbortController();
    const second = new AbortController();
    const reason = new Error("withdrawn");
    let signal: AbortSignal | undefined;
    const outcome = withTimeout({
      run: (given) => {
        signal = given;
        return new Promise<never>(() => undefined);
      },
      timeoutMs: HOUR,
      subject: "x",
      clock,
      signals: [first.signal, second.signal],
    });
    second.abort(reason);
    first.abort(new Error("later"));
    await expect(outcome).rejects.toBe(reason);
    expect(signal?.reason).toBe(reason);
    expect(clock.pending()).toBe(0);
  });

  it("never runs the handler under a signal that is already aborted", async () => {
    const clock = createFixedClock();
    const reason = new Error("withdrawn");
    let ran = false;
    await expect(
      withTimeout({
        run: () => {
          ran = true;
        },
        timeoutMs: HOUR,
        subject: "x",
        clock,
        signals: [new AbortController().signal, AbortSignal.abort(reason)],
      }),
    ).rejects.toBe(reason);
    expect(ran).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("stops listening to the signals once the race is over", async () => {
    const clock = createFixedClock();
    const controller = new AbortController();
    await expect(
      withTimeout({
        run: () => "done",
        timeoutMs: HOUR,
        subject: "x",
        clock,
        signals: [controller.signal],
      }),
    ).resolves.toBe("done");
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("cancels its wait whichever side wins", async () => {
    const clock = createFixedClock();
    await withTimeout({ run: () => 1, timeoutMs: HOUR, subject: "x", clock });
    expect(clock.pending()).toBe(0);
    await withTimeout({
      run: () => Promise.reject(new Error("boom")),
      timeoutMs: HOUR,
      subject: "x",
      clock,
    }).catch(() => undefined);
    expect(clock.pending()).toBe(0);
  });
});
