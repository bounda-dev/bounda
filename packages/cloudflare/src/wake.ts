export interface NextWakeArgs {
  // `false` when the last round of work ran out of passes with work left.
  readonly idle: boolean;
  // `true` after an alarm: events still behind the head are held by a retry back-off, not new.
  // `false` after a command: they are new and should be handled at once.
  readonly settled: boolean;
  // How far the furthest subscriber is behind the head of the stream.
  readonly lag: number;
  // A paused read model rebuild: `"next"` when its next slice can run at once, `"held"` when the
  // last one failed and should wait `retryMs`.
  readonly rebuild: "none" | "next" | "held";
  // When the next scheduled command or process time-out is due.
  readonly due: Date | null;
  readonly now: number;
  readonly retryMs: number;
}

export interface NextWakeFunction {
  (args: NextWakeArgs): number | null;
}

// A time on the app clock, in milliseconds like `now`, not a delay.
export const nextWake: NextWakeFunction = ({ idle, settled, lag, rebuild, due, now, retryMs }) => {
  const candidates: number[] = [];
  if (!idle || rebuild === "next") candidates.push(now);
  if (lag > 0) candidates.push(settled ? now + retryMs : now);
  if (rebuild === "held") candidates.push(now + retryMs);
  if (due !== null) candidates.push(Math.max(due.getTime(), now));
  return candidates.length === 0 ? null : Math.min(...candidates);
};
