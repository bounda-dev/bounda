import { describe, expect, it } from "vitest";
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
});
