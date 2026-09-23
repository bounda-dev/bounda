import { describe, expect, it, vi } from "vitest";
import { createFixedClock, systemClock } from "../../contracts/clock.ts";
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

  it("clears its timer whichever side wins", async () => {
    vi.useFakeTimers();
    try {
      await withTimeout({ run: () => 1, timeoutMs: 1_000, subject: "x", clock: systemClock });
      expect(vi.getTimerCount()).toBe(0);
      await withTimeout({
        run: () => Promise.reject(new Error("boom")),
        timeoutMs: 1_000,
        subject: "x",
        clock: systemClock,
      }).catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
