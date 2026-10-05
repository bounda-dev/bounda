import type { FixedClock } from "../../contracts/clock.ts";

/**
 * Where a reaction held in the inbox, waiting for its back-off, says when its retry becomes due.
 * A held reaction says it again on every pass, so a round knows exactly the retries still to come.
 */
export interface PendingRetries {
  /**
   * Starts a round of `runUntilIdle`: what was reported before no longer counts, since a reaction
   * that still waits reports again and one that will not run again does not.
   */
  startRound(): void;
  waiting(at: Date): void;
  /**
   * Called once the app is idle. Moves the clock to the earliest retry still to come, a reaction's
   * or the one `retried` says a scheduled command waits for, or to what `scheduled` says falls due
   * before it, so everything runs in the order it falls due; `false` when no retry is waiting.
   */
  skipToNext(
    scheduled: () => Promise<Date | null>,
    retried: () => Promise<Date | null>,
  ): Promise<boolean>;
}

export const ignoredRetries: PendingRetries = {
  startRound: () => {},
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
    startRound: () => {
      due.clear();
      dueNow = false;
    },
    waiting: (at) => {
      if (at.getTime() <= clock.now().getTime()) dueNow = true;
      else due.add(at.getTime());
    },
    skipToNext: async (scheduled, retried) => {
      if (dueNow) return true;
      const now = clock.now().getTime();
      const command = (await retried())?.getTime();
      const retries = [...due, ...(command !== undefined && command > now ? [command] : [])];
      if (retries.length === 0) return false;
      const retry = Math.min(...retries);
      const before = (await scheduled())?.getTime() ?? retry;
      clock.set(new Date(before > now && before < retry ? before : retry));
      return true;
    },
  };
};
