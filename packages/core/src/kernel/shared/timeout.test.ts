import { describe, expect, it, vi } from "vitest";
import { HandlerTimeoutError, withTimeout } from "./timeout.ts";

describe("withTimeout", () => {
  it("returns the value of a handler that finishes in time", async () => {
    await expect(withTimeout({ run: () => 42, timeoutMs: 50, subject: "x" })).resolves.toBe(42);
    await expect(withTimeout({ run: async () => "ok", timeoutMs: 50, subject: "x" })).resolves.toBe(
      "ok",
    );
  });

  it("rejects with HandlerTimeoutError when the handler is too slow", async () => {
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
    let error: unknown;
    try {
      await withTimeout({ run: slow, timeoutMs: 10, subject: "policy x" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HandlerTimeoutError);
    expect((error as HandlerTimeoutError).code).toBe("HANDLER_TIMEOUT");
    expect((error as Error).message).toBe("policy x did not finish within 10ms");
  });

  it("propagates handler errors", async () => {
    await expect(
      withTimeout({ run: () => Promise.reject(new Error("boom")), timeoutMs: 50, subject: "x" }),
    ).rejects.toThrow("boom");
  });

  it("clears its timer whichever side wins", async () => {
    vi.useFakeTimers();
    try {
      await withTimeout({ run: () => 1, timeoutMs: 1_000, subject: "x" });
      expect(vi.getTimerCount()).toBe(0);
      await withTimeout({
        run: () => Promise.reject(new Error("boom")),
        timeoutMs: 1_000,
        subject: "x",
      }).catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
