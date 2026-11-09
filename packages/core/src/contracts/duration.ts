import { ValidationError } from "./errors.ts";

export type DurationUnit = "ms" | "s" | "m" | "h" | "d";

/**
 * The string form of a duration: `"250ms"`, `"30s"`, `"5m"`, `"2h"`, `"7d"`.
 */
export type DurationString = `${number}${DurationUnit}`;

/**
 * A duration as users write it in `bounda.config.ts`: milliseconds or a duration string. The
 * compiler checks the unit because the config object is contextually typed.
 */
export type DurationInput = number | DurationString;

/**
 * A duration where the compiler cannot check the string, such as the object a process `config`
 * returns. Validated at boot.
 */
export type LooseDurationInput = number | string;

const MILLISECONDS_PER_UNIT: Readonly<Record<DurationUnit, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

export interface ParseDurationFunction {
  (input: LooseDurationInput): number;
}

export const parseDuration: ParseDurationFunction = (input) => {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new ValidationError(`Invalid duration: ${input}`, [
        { path: [], message: "Duration must be a non-negative finite number of milliseconds" },
      ]);
    }
    return input;
  }
  const match = DURATION_PATTERN.exec(input);
  if (match === null) {
    throw new ValidationError(`Invalid duration: "${input}"`, [
      { path: [], message: 'Expected a number followed by one of "ms", "s", "m", "h", "d"' },
    ]);
  }
  const [, amount, unit] = match;
  return Number(amount) * MILLISECONDS_PER_UNIT[unit as DurationUnit];
};

export interface AsDurationFunction {
  (input: LooseDurationInput): DurationInput;
}

/**
 * Checks a duration that the compiler could not, such as one read from an environment variable,
 * and returns it typed for places that want a `DurationInput`:
 * `{ delay: asDuration(process.env.REMINDER_DELAY ?? "24h") }`. Throws `ValidationError` when
 * the string is malformed.
 */
export const asDuration: AsDurationFunction = (input) => {
  parseDuration(input);
  return input as DurationInput;
};

/**
 * The units a retention takes besides a duration's: months and years of the calendar.
 */
export type CalendarUnit = "mo" | "y";

/**
 * A retention as users write it: milliseconds, a duration string, or a whole number of calendar
 * months or years, `"6mo"`, `"6y"`, which a legal period is usually given in and which days
 * cannot say, leap years and months of unequal length being what they are.
 */
export type RetentionInput = DurationInput | `${number}${CalendarUnit}`;

/**
 * A retention as the runtime counts it: calendar months, or milliseconds, one of them `0`.
 */
export interface Retention {
  readonly months: number;
  readonly ms: number;
}

const CALENDAR_PATTERN = /^(\d+(?:\.\d+)?)(mo|y)$/;

export interface ParseRetentionFunction {
  (input: LooseDurationInput): Retention;
}

/**
 * Throws `ValidationError` for anything but a duration or a whole number of months or years.
 */
export const parseRetention: ParseRetentionFunction = (input) => {
  const match = typeof input === "string" ? CALENDAR_PATTERN.exec(input) : null;
  if (match === null) return { months: 0, ms: parseDuration(input) };
  const [, amount, unit] = match;
  if (!Number.isInteger(Number(amount))) {
    throw new ValidationError(`Invalid retention: "${input}"`, [
      { path: [], message: "Expected a whole number of months or years" },
    ]);
  }
  return { months: Number(amount) * (unit === "y" ? 12 : 1), ms: 0 };
};

const lastDayOf = (year: number, month: number): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

const endOfMonth = (year: number, month: number): number =>
  Date.UTC(year, month, lastDayOf(year, month), 23, 59, 59, 999);

// The same day and time `months` later; a day the month lacks, as the 29th of February six years
// on, becomes the very end of the month's last day, so a period is never cut short and a later
// start never ends earlier.
const addMonths = (time: number, months: number): number => {
  const at = new Date(time);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + months;
  const day = at.getUTCDate();
  if (day > lastDayOf(year, month)) return endOfMonth(year, month);
  return Date.UTC(
    year,
    month,
    day,
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
    at.getUTCMilliseconds(),
  );
};

export interface RetentionEndFunction {
  (start: number, retention: Retention): number;
}

/**
 * When a retention that starts at `start` ends, in milliseconds.
 */
export const retentionEnd: RetentionEndFunction = (start, { months, ms }) =>
  addMonths(start, months) + ms;

export interface RetentionStartFunction {
  (end: number, retention: Retention): number;
}

/**
 * The latest start whose retention has ended by `end`: every start at or before it has ended,
 * every later one has not.
 */
export const retentionStart: RetentionStartFunction = (end, { months, ms }) => {
  const by = end - ms;
  const at = new Date(by);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() - months;
  // Starts on days the end's month lacks end at the very end of its last day.
  const endsTheMonth = by === endOfMonth(year, at.getUTCMonth());
  if (endsTheMonth || at.getUTCDate() > lastDayOf(year, month)) return endOfMonth(year, month);
  return Date.UTC(
    year,
    month,
    at.getUTCDate(),
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
    at.getUTCMilliseconds(),
  );
};
