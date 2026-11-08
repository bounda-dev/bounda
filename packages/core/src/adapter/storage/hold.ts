/**
 * A wait the runtime keeps on a row after an attempt on it came to nothing, because it failed or
 * found the row not ready yet: the row is not tried again before `until`, an ISO timestamp, and
 * `attempts` counts the failures in a row so far, from which the next wait grows. It is written
 * with the row, never when an attempt succeeds, so every instance sees it and a restart keeps it.
 */
export interface Hold {
  readonly until: string;
  readonly attempts: number;
}

export interface IsReleasedByFunction {
  (hold: Hold | null, at: Date | undefined): boolean;
}

/**
 * Whether a row with `hold` may be tried at `at`, as `releasedBy` lists it; any row when `at` is
 * not given. Timestamps are ISO strings of one length, so they compare as text, as SQL compares them.
 */
export const isReleasedBy: IsReleasedByFunction = (hold, at) =>
  at === undefined || hold === null || hold.until <= at.toISOString();
