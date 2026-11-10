import { describe, expect, it } from "vitest";
import {
  asDuration,
  parseDuration,
  parseRetention,
  retentionEnd,
  retentionStart,
} from "./duration.ts";
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

describe("parseRetention", () => {
  it("takes a duration, or whole calendar months and years", () => {
    expect(parseRetention("30d")).toEqual({ months: 0, ms: 2_592_000_000 });
    expect(parseRetention(1_000)).toEqual({ months: 0, ms: 1_000 });
    expect(parseRetention("6y")).toEqual({ months: 72, ms: 0 });
    expect(parseRetention("18mo")).toEqual({ months: 18, ms: 0 });
    expect(parseRetention("5m")).toEqual({ months: 0, ms: 300_000 });
  });

  it("refuses a fraction of a month or a year, and anything that is not a duration", () => {
    for (const input of ["1.5y", "0.5mo"]) {
      expect(() => parseRetention(input)).toThrow(
        new ValidationError(`Invalid retention: "${input}"`, [
          { path: [], message: "Expected a whole number of months or years" },
        ]),
      );
    }
    expect(() => parseRetention("6 years")).toThrow(ValidationError);
    expect(() => parseRetention("y")).toThrow(ValidationError);
  });
});

describe("retentionEnd and retentionStart", () => {
  const at = (text: string): number => Date.parse(text);
  const iso = (time: number): string => new Date(time).toISOString();
  const years = (count: number) => ({ months: count * 12, ms: 0 });
  const months = (count: number) => ({ months: count, ms: 0 });

  it("ends a calendar period on the same day and time, whatever the leap years between", () => {
    expect(iso(retentionEnd(at("2026-03-15T10:30:00.000Z"), years(6)))).toBe(
      "2032-03-15T10:30:00.000Z",
    );
    expect(iso(retentionEnd(at("2026-01-31T08:00:00.000Z"), months(1)))).toBe(
      "2026-02-28T23:59:59.999Z",
    );
    expect(iso(retentionEnd(at("2024-02-29T08:00:00.000Z"), years(6)))).toBe(
      "2030-02-28T23:59:59.999Z",
    );
    expect(iso(retentionEnd(at("2024-02-29T08:00:00.000Z"), years(4)))).toBe(
      "2028-02-29T08:00:00.000Z",
    );
    expect(iso(retentionEnd(at("2026-11-30T00:00:00.000Z"), months(3)))).toBe(
      "2027-02-28T23:59:59.999Z",
    );
    expect(retentionEnd(1_000, { months: 0, ms: 500 })).toBe(1_500);
  });

  it("starts at the latest moment whose period has ended, so a sweep forgets neither early nor late", () => {
    expect(iso(retentionStart(at("2032-03-15T10:30:00.000Z"), years(6)))).toBe(
      "2026-03-15T10:30:00.000Z",
    );
    expect(iso(retentionStart(at("2026-03-31T10:00:00.000Z"), months(1)))).toBe(
      "2026-02-28T23:59:59.999Z",
    );
    expect(iso(retentionStart(at("2026-02-28T23:59:59.999Z"), months(1)))).toBe(
      "2026-01-31T23:59:59.999Z",
    );
    expect(iso(retentionStart(at("2026-02-28T12:00:00.000Z"), months(1)))).toBe(
      "2026-01-28T12:00:00.000Z",
    );
    expect(retentionStart(1_500, { months: 0, ms: 500 })).toBe(1_000);
    const day = 86_400_000;
    for (
      let start = at("2024-01-25T06:00:00.000Z");
      start < at("2024-04-05T00:00:00.000Z");
      start += day / 4
    ) {
      for (const retention of [months(1), months(13), years(1)]) {
        const end = retentionEnd(start, retention);
        expect(retentionStart(end, retention)).toBeGreaterThanOrEqual(start);
        expect(retentionStart(end - 1, retention)).toBeLessThan(start);
      }
    }
  });
});
