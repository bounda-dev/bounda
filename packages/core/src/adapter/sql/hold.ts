import type { Hold } from "../storage/hold.ts";

export interface HoldOfFunction {
  (row: Record<string, unknown>): Hold | null;
}

// A hold lives in two columns, `held_until` and `attempts`; `attempts` alone means nothing.
export const holdOf: HoldOfFunction = (row) =>
  row.held_until === null || row.held_until === undefined
    ? null
    : { until: String(row.held_until), attempts: Number(row.attempts) };
