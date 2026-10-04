import type { FixedClock } from "../../contracts/clock.ts";

/**
 * Where a retry waiting for its back-off says when it becomes due: a reaction held in the inbox,
 * or a scheduled command rescheduled after a failure.
 */
export interface PendingRetries {
  waiting(at: Date): void;
  /**
   * Called once the app is idle. Moves the clock to the earliest retry still to come, or to what
   * `scheduled` says falls due before it, so everything runs in the order it falls due; `false`
   * when no retry is waiting.
   */
  skipToNext(scheduled: () => Promise<Date | null>): Promise<boolean>;
}

export const ignoredRetries: PendingRetries = {
  waiting: () => {},
  skipToNext: async () => false,
};

export interface CreatePendingRetriesFunction {
  (clock: FixedClock): PendingRetries;
}

export const createPendingRetries: CreatePendingRetriesFunction = (clock) => {
  const due = new Set<number>();
  // A retry without back-off is due as soon as it fails, so the app is idle with it still waiting.
  let dueNow = false;
  return {
    waiting: (at) => {
      if (at.getTime() <= clock.now().getTime()) dueNow = true;
      else due.add(at.getTime());
    },
    skipToNext: async (scheduled) => {
      if (dueNow) {
        dueNow = false;
        return true;
      }
      // The app is idle, so a retry whose time has come has run, and reported its next time if
      // it failed again.
      const now = clock.now().getTime();
      for (const at of due) if (at <= now) due.delete(at);
      if (due.size === 0) return false;
      const retry = Math.min(...due);
      const before = (await scheduled())?.getTime() ?? retry;
      clock.set(new Date(before > now && before < retry ? before : retry));
      return true;
    },
  };
};
