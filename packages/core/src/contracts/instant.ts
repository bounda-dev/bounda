import { z } from "zod";
import { ValidationError } from "./errors.ts";

/**
 * The schema of a moment in a process state: an ISO 8601 date and time in UTC, as
 * `Date.prototype.toISOString` writes it.
 */
export const instantSchema: z.core.$ZodBranded<z.ZodISODateTime, "Instant", "out"> = z.iso
  .datetime()
  .brand<"Instant">();

/**
 * A moment in a process state: an ISO 8601 string in UTC, branded so that only `after()`,
 * `asInstant` or a stored state produce one.
 */
export type Instant = z.output<typeof instantSchema>;

/**
 * The signature of `asInstant`.
 */
export interface AsInstantFunction {
  (value: Date | string): Instant;
}

/**
 * Turns a date, or an ISO 8601 string in UTC, into an `Instant`: what a test hands a process
 * handler as a state it did not build with `after()`. Throws `ValidationError` for anything else.
 */
export const asInstant: AsInstantFunction = (value) => {
  const parsed = instantSchema.safeParse(
    value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : value,
  );
  if (parsed.success) return parsed.data;
  throw new ValidationError(`Invalid instant: ${JSON.stringify(value)}`, [
    {
      path: [],
      message: "Expected an ISO 8601 date and time in UTC, such as 2026-01-01T00:00:00.000Z",
    },
  ]);
};
