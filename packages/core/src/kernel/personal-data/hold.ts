import type { Hold } from "../../adapter/storage/hold.ts";
import type { ResolvedRetryConfig } from "../../config/types.ts";
import { retryDelayMs } from "../shared/retry.ts";

/**
 * How long a row the runtime could not settle waits before it is tried again, twice as long after
 * each failure in a row up to `HOLD_MAX_MS`.
 */
export const HOLD_MS = 30_000;

export const HOLD_MAX_MS = 3_600_000;

const HOLD_RETRY: ResolvedRetryConfig = {
  strategy: "exponential",
  baseDelayMs: HOLD_MS,
  maxDelayMs: HOLD_MAX_MS,
  maxAttempts: Number.POSITIVE_INFINITY,
};

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
  const delay = retryDelayMs({ retry: HOLD_RETRY, attempt: Math.max(attempts, 1) });
  return { until: new Date(at + delay).toISOString(), attempts };
};

/**
 * What a job does when the store itself fails it, a list it cannot read or a hold it cannot
 * write: it stops for a while, longer after each failure in a row, since no row can keep the wait.
 */
export interface Pause {
  isPaused(at: number): boolean;
  pause(at: number): void;
  /**
   * After a pass the store answered in full: the next failure waits as long as the first.
   */
  resume(): void;
  /**
   * After a pass: `resume` when the store kept every hold it wrote, `pause` otherwise.
   */
  settle(at: number, kept: boolean): void;
  /**
   * `next`, or the end of the pause when that is later.
   */
  notBefore(next: number): number;
}

export interface CreatePauseFunction {
  (): Pause;
}

export const createPause: CreatePauseFunction = () => {
  let paused: Hold | null = null;
  const until = (): number =>
    paused === null ? Number.NEGATIVE_INFINITY : Date.parse(paused.until);
  const pause = (at: number): void => {
    paused = holdAfter({ held: paused, at, failed: true });
  };
  const resume = (): void => {
    paused = null;
  };
  return {
    isPaused: (at) => at < until(),
    pause,
    resume,
    settle: (at, kept) => (kept ? resume() : pause(at)),
    notBefore: (next) => Math.max(next, until()),
  };
};
