export interface NextWakeArgs {
  /**
   * Whether the last round of work reached idle. `false` when it ran out of passes with work left.
   */
  readonly idle: boolean;
  /**
   * `true` after an alarm: events still behind the head are held by a retry back-off, not new.
   * `false` after a command: they are new and should be handled at once.
   */
  readonly settled: boolean;
  /**
   * How far the furthest subscriber is behind the head of the stream.
   */
  readonly lag: number;
  /**
   * When the next scheduled command or process time-out is due, if any.
   */
  readonly due: Date | null;
  readonly now: number;
  /**
   * How long to wait before looking again at work held by a retry back-off.
   */
  readonly retryMs: number;
}

export interface NextWakeFunction {
  (args: NextWakeArgs): number | null;
}

/**
 * When a Durable Object should wake up next, in the app clock's milliseconds, or `null` when
 * nothing is pending: at once for work left or new events, after `retryMs` for events a retry is
 * holding, at the due time for scheduled work, whichever comes first.
 */
export const nextWake: NextWakeFunction = ({ idle, settled, lag, due, now, retryMs }) => {
  const candidates: number[] = [];
  if (!idle) candidates.push(now);
  if (lag > 0) candidates.push(settled ? now + retryMs : now);
  if (due !== null) candidates.push(Math.max(due.getTime(), now));
  return candidates.length === 0 ? null : Math.min(...candidates);
};
