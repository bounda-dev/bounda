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
