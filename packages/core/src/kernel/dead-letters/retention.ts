import type { DeadLetterStore } from "../../adapter/storage/dead-letter-store.ts";
import type { Logger } from "../../contracts/logger.ts";
import { createPause } from "../personal-data/hold.ts";
import { errorDetails } from "../shared/retry.ts";

// How many resolved letters a pass of the worker removes at most.
export const DEAD_LETTER_PURGE_LIMIT = 100;

export interface DeadLetterRetention {
  /**
   * Removes up to `DEAD_LETTER_PURGE_LIMIT` letters resolved longer than the retention ago at
   * `now`, and resolves to how many it removed. Never rejects: a store that fails is logged, and
   * the sweep waits a while before it tries again.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the earliest resolved letter outlives the retention, `null` when no letter is resolved.
   */
  nextDueAt(): Promise<Date | null>;
}

export interface CreateDeadLetterRetentionArgs {
  readonly store: DeadLetterStore;
  readonly retentionMs: number;
  readonly logger: Logger;
}

export interface CreateDeadLetterRetentionFunction {
  (args: CreateDeadLetterRetentionArgs): DeadLetterRetention;
}

/**
 * Asks the store first when the earliest resolved letter is due, a read an index answers, so a
 * pass with nothing due writes nothing.
 */
export const createDeadLetterRetention: CreateDeadLetterRetentionFunction = ({
  store,
  retentionMs,
  logger,
}) => {
  const pause = createPause();
  const dueAt = (resolvedAt: Date | null): number | null =>
    resolvedAt === null ? null : resolvedAt.getTime() + retentionMs;

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at)) return 0;
      try {
        const due = dueAt(await store.firstResolvedAt());
        const purged =
          due === null || due > at
            ? 0
            : await store.purge({
                resolvedBy: new Date(at - retentionMs),
                limit: DEAD_LETTER_PURGE_LIMIT,
              });
        pause.resume();
        if (purged > 0) logger.info("resolved dead letters purged", { purged });
        return purged;
      } catch (error) {
        pause.pause(at);
        logger.error("resolved dead letters could not be purged", errorDetails(error));
        return 0;
      }
    },
    nextDueAt: async () => {
      const due = dueAt(await store.firstResolvedAt());
      return due === null ? null : new Date(pause.notBefore(due));
    },
  };
};
