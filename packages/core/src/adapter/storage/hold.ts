/**
 * A wait the runtime keeps on a row after an attempt on it came to nothing: the row is not tried
 * again before `until`, an ISO timestamp, and `attempts` counts the failures in a row so far, from
 * which the next wait grows. It is written with the row only when an attempt fails, so every
 * instance sees it and a restart keeps it.
 */
export interface Hold {
  readonly until: string;
  readonly attempts: number;
}
