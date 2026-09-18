import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.ts";
import { ValidationError } from "./errors.ts";

describe("parseDuration", () => {
  it("returns numbers as milliseconds", () => {
    expect(parseDuration(1500)).toBe(1500);
    expect(parseDuration(0)).toBe(0);
  });

  it.each([
    ["250ms", 250],
    ["30s", 30_000],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["7d", 604_800_000],
    ["1.5h", 5_400_000],
  ] as const)("parses %s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("rejects negative and non-finite numbers", () => {
    expect(() => parseDuration(-1)).toThrow(ValidationError);
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });

  it("rejects malformed strings with a readable message", () => {
    expect(() => parseDuration("7 days" as never)).toThrow('Invalid duration: "7 days"');
    expect(() => parseDuration("m5" as never)).toThrow(ValidationError);
    expect(() => parseDuration("" as never)).toThrow(ValidationError);
  });
});
