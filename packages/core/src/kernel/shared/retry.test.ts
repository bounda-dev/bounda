import { describe, expect, it } from "vitest";
import {
  ChainDepthExceededError,
  ConcurrencyError,
  ConfigurationError,
  DomainError,
  NotFoundError,
  ValidationError,
} from "../../contracts/errors.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "./retry.ts";

describe("classifyFailure", () => {
  it("treats request errors as terminal and everything else as retriable", () => {
    expect(classifyFailure(new DomainError("no"))).toBe("terminal");
    expect(classifyFailure(new ValidationError("no", []))).toBe("terminal");
    expect(classifyFailure(new NotFoundError("no"))).toBe("terminal");
    expect(classifyFailure(new ConfigurationError("no"))).toBe("terminal");
    expect(classifyFailure(new ChainDepthExceededError(3, 2))).toBe("terminal");
    expect(classifyFailure(new Error("socket hang up"))).toBe("retriable");
    expect(classifyFailure("string")).toBe("retriable");
    expect(
      classifyFailure(
        new ConcurrencyError({ streamId: "s", expectedVersion: 1, actualVersion: 2 }),
      ),
    ).toBe("retriable");
  });
});

describe("retryDelayMs", () => {
  const base = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 5_000 };

  it.each([
    ["none", 1, 0],
    ["fixed", 3, 1_000],
    ["linear", 3, 3_000],
    ["exponential", 1, 1_000],
    ["exponential", 3, 4_000],
    ["exponential", 4, 5_000],
  ] as const)("%s attempt %i → %ims", (strategy, attempt, expected) => {
    expect(retryDelayMs({ retry: { ...base, strategy }, attempt })).toBe(expected);
  });
});

describe("errorDetails", () => {
  it("extracts message and stack from errors and stringifies the rest", () => {
    const details = errorDetails(new Error("boom"));
    expect(details.message).toBe("boom");
    expect(details.stack).toContain("boom");
    expect(errorDetails(42)).toEqual({ message: "42" });
  });

  it("omits the stack when the error has none", () => {
    const bare = new Error("bare");
    Reflect.deleteProperty(bare, "stack");
    expect(errorDetails(bare)).toEqual({ message: "bare" });
    expect(errorDetails(bare)).not.toHaveProperty("stack");
  });
});
