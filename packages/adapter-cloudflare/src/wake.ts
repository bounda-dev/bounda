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
   * Whether a read model rebuild is paused: `"next"` when its next slice can run at once,
   * `"held"` when the last one failed and should wait `retryMs`.
   */
  readonly rebuild: "none" | "next" | "held";
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
 * nothing is pending: at once for work left, new events or a rebuild's next slice, after
 * `retryMs` for events a retry is holding or a rebuild slice that failed, at the due time for
 * scheduled work, whichever comes first.
 */
export const nextWake: NextWakeFunction = ({ idle, settled, lag, rebuild, due, now, retryMs }) => {
  const candidates: number[] = [];
  if (!idle || rebuild === "next") candidates.push(now);
  if (lag > 0) candidates.push(settled ? now + retryMs : now);
  if (rebuild === "held") candidates.push(now + retryMs);
  if (due !== null) candidates.push(Math.max(due.getTime(), now));
  return candidates.length === 0 ? null : Math.min(...candidates);
};
