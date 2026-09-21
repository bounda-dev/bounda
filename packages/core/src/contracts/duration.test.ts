import { describe, expect, it } from "vitest";
import { asDuration, parseDuration } from "./duration.ts";
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
    const failure = (): unknown => parseDuration(-1);
    expect(failure).toThrow("Invalid duration: -1");
    try {
      failure();
    } catch (error) {
      expect((error as ValidationError).issues).toEqual([
        { path: [], message: "Duration must be a non-negative finite number of milliseconds" },
      ]);
    }
  });

  it("rejects malformed strings with a readable message", () => {
    expect(() => parseDuration("7 days")).toThrow('Invalid duration: "7 days"');
    expect(() => parseDuration("m5")).toThrow(ValidationError);
    expect(() => parseDuration("")).toThrow(ValidationError);
    try {
      parseDuration("soon");
    } catch (error) {
      expect((error as ValidationError).issues).toEqual([
        { path: [], message: 'Expected a number followed by one of "ms", "s", "m", "h", "d"' },
      ]);
    }
  });
});

describe("asDuration", () => {
  it("returns a valid duration unchanged and rejects a malformed one", () => {
    expect(asDuration("24h")).toBe("24h");
    expect(asDuration(1_500)).toBe(1_500);
    expect(() => asDuration("soon")).toThrow(ValidationError);
  });
});
