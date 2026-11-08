import type { Hold } from "../storage/hold.ts";

export interface HoldOfFunction {
  (row: Record<string, unknown>): Hold | null;
}

// A hold lives in two columns, `held_until` and `attempts`; `attempts` alone means nothing.
export const holdOf: HoldOfFunction = (row) =>
  typeof row.held_until === "string"
    ? { until: row.held_until, attempts: Number(row.attempts) }
    : null;

export interface ReleasedByFunction {
  (placeholder: string): string;
}

// The rows a list may take at a moment: not held, or held until then at the latest.
export const releasedBy: ReleasedByFunction = (placeholder) =>
  `("held_until" IS NULL OR "held_until" <= ${placeholder})`;

export interface HoldEndOfFunction {
  (rows: readonly Record<string, unknown>[]): Date | null;
}

// What `SELECT MIN("held_until") AS "until"` answers: no row and a NULL minimum mean no hold.
export const holdEndOf: HoldEndOfFunction = ([row]) =>
  typeof row?.until === "string" ? new Date(row.until) : null;
