import type { FixedClock } from "../../contracts/clock.ts";

/**
 * Where a retry waiting for its back-off says when it becomes due: a reaction held in the inbox,
 * or a scheduled command rescheduled after a failure.
 */
export interface PendingRetries {
  waiting(at: Date): void;
  /**
   * Moves the clock to the earliest retry still to come; `false` when there is none.
   */
  skipToNext(): boolean;
}

export const ignoredRetries: PendingRetries = {
  waiting: () => {},
  skipToNext: () => false,
};

export interface CreatePendingRetriesFunction {
  (clock: FixedClock): PendingRetries;
}

export const createPendingRetries: CreatePendingRetriesFunction = (clock) => {
  const due = new Set<number>();
  return {
    waiting: (at) => {
      due.add(at.getTime());
    },
    skipToNext: () => {
      // Only called once the app is idle, so a retry whose time has come has run, and reported
      // its next time if it failed again.
      const now = clock.now().getTime();
      for (const at of due) if (at <= now) due.delete(at);
      if (due.size === 0) return false;
      clock.set(new Date(Math.min(...due)));
      return true;
    },
  };
};
