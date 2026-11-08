import type { Hold } from "../storage/hold.ts";

export interface HoldOfFunction {
  (row: Record<string, unknown>): Hold | null;
}

// A hold lives in two columns, `held_until` and `attempts`; `attempts` alone means nothing.
export const holdOf: HoldOfFunction = (row) =>
  typeof row.held_until === "string"
    ? { until: row.held_until, attempts: Number(row.attempts) }
    : null;
