import type { Hold } from "../../adapter/storage/hold.ts";

/**
 * How long a row the runtime could not settle waits before it is tried again, twice as long after
 * each failure in a row up to `HOLD_MAX_MS`; and how long a list that could not be read holds the
 * work it feeds.
 */
export const HOLD_MS = 30_000;

export const HOLD_MAX_MS = 3_600_000;

export interface HoldAfterArgs {
  /**
   * The hold the row had, ended or not.
   */
  readonly held: Hold | null;
  readonly at: number;
  /**
   * Whether the attempt failed: a row left for later without failing, as one whose data is not
   * recorded yet, waits without backing off further.
   */
  readonly failed: boolean;
}

export interface HoldAfterFunction {
  (args: HoldAfterArgs): Hold;
}

export const holdAfter: HoldAfterFunction = ({ held, at, failed }) => {
  const attempts = (held?.attempts ?? 0) + (failed ? 1 : 0);
  const delay = Math.min(HOLD_MS * 2 ** Math.max(attempts - 1, 0), HOLD_MAX_MS);
  return { until: new Date(at + delay).toISOString(), attempts };
};
