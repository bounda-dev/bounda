import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import type { Logger } from "../../contracts/logger.ts";

/**
 * The checkpoint row the running instances move one forward, each at most once every
 * `GENERATION_INTERVAL_MS` and only after activity: it only ever grows, so a database that holds
 * less than an instance read from it, or than the forget ledger's mark, went back to an earlier
 * copy.
 */
export const RESTORE_GENERATION = "runtime:generation";

/**
 * The checkpoint row that counts the restores the instances found, moved by the first to find
 * one, so the others, whose own reading may not show it, learn of it too.
 */
export const RESTORES_FOUND = "runtime:restores";

/**
 * The forget ledger's mark the generation is raised to, outside the database: what tells a copy
 * restored while the app was stopped.
 */
export const RESTORE_MARK = "restore:generation";

export const GENERATION_INTERVAL_MS = 5_000;

// How often a moved generation is raised in the forget ledger at most, which a stop also does.
export const MARK_INTERVAL_MS = 60_000;

export interface Restored {
  /**
   * Whether this instance found it first: the one that clears what the copy brought back of the
   * holds, which a copy holds once.
   */
  readonly first: boolean;
}

export interface RestoreWatch {
  /**
   * Compares the database with what this instance read from it at start, against the forget
   * ledger's mark: `null` while it holds at least that. Never rejects: a ledger that cannot be
   * read is logged and asked again by `check`.
   */
  start(now: Date): Promise<Restored | null>;
  /**
   * Reads the rows and resolves to what this instance learnt: `null` while the database holds at
   * least what it read last. Moves the generation after activity, a write to the stream since the
   * last move or `active`. Never rejects: a store that fails is logged, and the next check reads
   * again.
   */
  check(now: Date, options?: CheckRestoreOptions): Promise<Restored | null>;
  /**
   * Records a restore an operator made: counted as found, so every running instance learns of
   * it, and this one first.
   */
  declare(): Promise<Restored>;
  /**
   * Raises the forget ledger's mark to the generation this instance read last; what a stop does.
   * Never rejects.
   */
  flush(): Promise<void>;
  /**
   * How many restores the instances found, as the database counts them.
   */
  found(): Promise<number>;
}

export interface CheckRestoreOptions {
  /**
   * Whether this instance wrote anything besides events since its last check, such as a key
   * rewrapped or a hold.
   */
  readonly active?: boolean;
}

export interface CreateRestoreWatchArgs {
  readonly checkpoints: CheckpointStore;
  readonly events: Pick<EventStore, "lastPosition">;
  /**
   * The forget ledger, outside the database; `null` without one, and a copy restored while the
   * app was stopped is then found only when declared.
   */
  readonly marks: Pick<ForgetLedger, "readMark" | "raiseMark"> | null;
  readonly logger: Logger;
}

export interface CreateRestoreWatchFunction {
  (args: CreateRestoreWatchArgs): RestoreWatch;
}

interface Seen {
  readonly generation: number;
  readonly restores: number;
}

/**
 * A generation that went back, or a count of restores that changed, means a restore. The first
 * instance to see the generation go back moves the count past every value an instance can have
 * read, so each other instance finds it changed, whether its own reading of the generation shows
 * the restore or not. A copy taken after the last move goes unseen: nothing was written since.
 */
export const createRestoreWatch: CreateRestoreWatchFunction = ({
  checkpoints,
  events,
  marks,
  logger,
}) => {
  let seen: Seen | null = null;
  let movedAt = Number.NEGATIVE_INFINITY;
  let markedAt = Number.NEGATIVE_INFINITY;
  let head: number | null = null;
  let pending = false;
  // While the ledger's mark could not be read, the generation stays where it is: moving it could
  // carry a copy restored while the app was stopped past the mark before it is compared.
  let unmarked = marks !== null;

  const read = async (): Promise<Seen> => {
    const [generation, restores] = await Promise.all([
      checkpoints.get(RESTORE_GENERATION),
      checkpoints.get(RESTORES_FOUND),
    ]);
    return { generation, restores };
  };

  // Counts the restore unless another instance did first, and moves the generation past
  // `floor`, so the copy's own value never reads as current again.
  const count = async (stored: Seen, past: number, floor: number): Promise<Restored> => {
    const counted = past + 1;
    const first = await checkpoints.compareAndSet(RESTORES_FOUND, stored.restores, counted);
    const restores = first ? counted : await checkpoints.get(RESTORES_FOUND);
    const generation = Math.max(stored.generation, floor) + 1;
    const moved = await checkpoints.compareAndSet(
      RESTORE_GENERATION,
      stored.generation,
      generation,
    );
    seen = { generation: moved ? generation : await checkpoints.get(RESTORE_GENERATION), restores };
    movedAt = Number.NEGATIVE_INFINITY;
    return { first };
  };

  const raise = async (at: number, generation: number): Promise<void> => {
    if (marks === null) return;
    try {
      await marks.raiseMark(RESTORE_MARK, generation);
      markedAt = at;
    } catch (error) {
      logger.error("the forget ledger's mark could not be raised", { error });
    }
  };

  // A mark past the database's generation: the database is a copy from before it.
  const compareWithMark = async (stored: Seen): Promise<Restored | null> => {
    if (marks === null) return null;
    const mark = await marks.readMark(RESTORE_MARK);
    unmarked = false;
    if (stored.generation >= mark) return null;
    const restored = await count(stored, stored.restores, mark);
    await marks.raiseMark(RESTORE_MARK, seen?.generation ?? mark);
    return restored;
  };

  const check = async (now: Date, active: boolean): Promise<Restored | null> => {
    const at = now.getTime();
    const [stored, last] = await Promise.all([read(), events.lastPosition()]);
    pending ||= active || (head !== null && last !== head);
    head = last;
    if (unmarked) {
      const restored = await compareWithMark(stored);
      if (restored !== null) return restored;
    }
    let restored: Restored | null = null;
    let current = stored;
    if (
      seen !== null &&
      (stored.generation < seen.generation || stored.restores !== seen.restores)
    ) {
      // A count past what this instance read was moved by the instance that found it first.
      if (stored.restores > seen.restores) {
        restored = { first: false };
      } else {
        restored = await count(stored, seen.restores, 0);
        current = seen;
      }
      pending = true;
    }
    if (pending && !unmarked && at - movedAt >= GENERATION_INTERVAL_MS) {
      const next = current.generation + 1;
      if (await checkpoints.compareAndSet(RESTORE_GENERATION, current.generation, next)) {
        current = { ...current, generation: next };
        if (at - markedAt >= MARK_INTERVAL_MS) await raise(at, next);
      }
      movedAt = at;
      pending = false;
    }
    seen = current;
    return restored;
  };

  const logged =
    (what: string) =>
    (error: unknown): null => {
      logger.error(what, { error });
      return null;
    };

  return {
    start: async (now) => {
      try {
        const stored = await read();
        head = await events.lastPosition();
        seen = stored;
        const restored = await compareWithMark(stored);
        if (restored === null && marks !== null) await raise(now.getTime(), stored.generation);
        return restored;
      } catch (error) {
        return logged("the database could not be compared with the forget ledger's mark")(error);
      }
    },
    check: (now, { active = false } = {}) =>
      check(now, active).catch(logged("the database could not be checked for a restore")),
    declare: async () => {
      const stored = await read();
      const restored = await count(stored, Math.max(stored.restores, seen?.restores ?? 0), 0);
      if (marks !== null && seen !== null) await marks.raiseMark(RESTORE_MARK, seen.generation);
      return restored;
    },
    flush: async () => {
      if (seen === null || unmarked) return;
      await raise(Number.NEGATIVE_INFINITY, seen.generation);
    },
    found: () => checkpoints.get(RESTORES_FOUND),
  };
};
