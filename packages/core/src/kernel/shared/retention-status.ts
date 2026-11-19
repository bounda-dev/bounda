/**
 * A purge of what the runtime keeps of its own work whose store could not be read when the status
 * was asked for: the error is logged, and the purge goes on trying on its own schedule.
 */
export interface UnreadableRetentionStatus {
  readonly retentionMs: number;
  readonly unreadable: true;
}
