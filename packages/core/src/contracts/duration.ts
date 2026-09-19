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

/**
 * Converts a duration input to milliseconds. Throws `ValidationError` on malformed strings or
 * negative numbers.
 */
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
