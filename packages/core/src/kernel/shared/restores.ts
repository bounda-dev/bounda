import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { Logger } from "../../contracts/logger.ts";

/**
 * The checkpoint row every running instance moves one forward, at most once every
 * `GENERATION_INTERVAL_MS`: it only ever grows, so a database that holds less than an instance
 * read from it went back to an earlier copy.
 */
export const RESTORE_GENERATION = "runtime:generation";

/**
 * The checkpoint row that counts the restores the instances found, moved by the first to find
 * one, so the others, whose own reading may not show it, learn of it too.
 */
export const RESTORES_FOUND = "runtime:restores";

export const GENERATION_INTERVAL_MS = 5_000;

export interface Restored {
  /**
   * Whether this instance found it first: the one that clears what the copy brought back of the
   * holds, which a copy holds once.
   */
  readonly first: boolean;
}

export interface RestoreWatch {
  /**
   * Reads the rows and resolves to what this instance learnt: `null` while the database holds
   * at least what it read last. A database restored while this instance was stopped is not
   * told apart from one left alone. Never rejects: a store that fails is logged, and the next
   * check reads again.
   */
  check(now: Date): Promise<Restored | null>;
  /**
   * How many restores the instances found, as the database counts them.
   */
  found(): Promise<number>;
}

export interface CreateRestoreWatchArgs {
  readonly checkpoints: CheckpointStore;
  readonly logger: Logger;
}

export interface CreateRestoreWatchFunction {
  (args: CreateRestoreWatchArgs): RestoreWatch;
}

/**
 * A generation that went back, or a count of restores that changed, means a restore. The first
 * instance to see the generation go back moves the count past every value an instance can have
 * read, so each other instance finds it changed, whether its own reading of the generation shows
 * the restore or not. A copy taken within one interval of the restore may hold the generation
 * every instance read last, and goes unseen: what it undid is that recent.
 */
export const createRestoreWatch: CreateRestoreWatchFunction = ({ checkpoints, logger }) => {
  let seen: { readonly generation: number; readonly restores: number } | null = null;
  let movedAt = Number.NEGATIVE_INFINITY;

  const check = async (now: Date): Promise<Restored | null> => {
    const at = now.getTime();
    const [generation, restores] = await Promise.all([
      checkpoints.get(RESTORE_GENERATION),
      checkpoints.get(RESTORES_FOUND),
    ]);
    let restored: Restored | null = null;
    let counted = restores;
    if (seen !== null && (generation < seen.generation || restores !== seen.restores)) {
      // A count past what this instance read was moved by the instance that found it first.
      if (restores > seen.restores) {
        restored = { first: false };
      } else {
        counted = seen.restores + 1;
        const first = await checkpoints.compareAndSet(RESTORES_FOUND, restores, counted);
        if (!first) counted = await checkpoints.get(RESTORES_FOUND);
        restored = { first };
      }
      movedAt = Number.NEGATIVE_INFINITY;
    }
    let current = generation;
    if (at - movedAt >= GENERATION_INTERVAL_MS) {
      if (await checkpoints.compareAndSet(RESTORE_GENERATION, generation, generation + 1)) {
        current = generation + 1;
      }
      movedAt = at;
    }
    seen = { generation: current, restores: counted };
    return restored;
  };

  return {
    check: (now) =>
      check(now).catch((error: unknown) => {
        logger.error("the database could not be checked for a restore", { error });
        return null;
      }),
    found: () => checkpoints.get(RESTORES_FOUND),
  };
};
