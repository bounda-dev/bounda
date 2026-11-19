/**
 * A part of `app.status()` whose store could not be read when the status was asked for: the error
 * is logged once for the call, and every other part still comes back.
 */
export interface UnreadableStatus {
  readonly unreadable: true;
}

/**
 * A purge of what the runtime keeps of its own work whose store could not be read when the status
 * was asked for: the error is logged, and the purge goes on trying on its own schedule.
 */
export interface UnreadableRetentionStatus extends UnreadableStatus {
  readonly retentionMs: number;
}
