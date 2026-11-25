import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { ForgetLedger, LedgerReached } from "../../adapter/storage/forget-ledger.ts";
import { isFenceError } from "../../adapter/storage/tenant-fence.ts";
import type { Logger } from "../../contracts/logger.ts";
import { eventMark } from "../read-model/stream-marks.ts";

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
 * The count of a restore an adapter made in place and counted in its own transaction, until the
 * instance that finds it first takes it: what lets an app without a forget ledger, stopped or
 * running, find such a restore, and counts it exactly once.
 */
export const RESTORE_UNCLAIMED = "runtime:restore-unclaimed";

/**
 * The count a declaration of a restore moves the restores to, until the restore is handled: a
 * declaration made again, or the next start, finishes it rather than counting another.
 */
export const RESTORE_DECLARING = "runtime:restore-declaring";

/**
 * The database as the last restore an instance counted left it once handled, as one hash of its
 * count of restores and of its newest event and that event's position, in one row so two instances
 * settling at once leave one or the other: an operator's declaration that finds the database
 * standing exactly there, not behind the forget ledger's mark, counts nothing unless told `again`.
 */
export const RESTORE_HANDLED = "runtime:restore-handled";

/**
 * The forget ledger's mark the generation is raised to, outside the database: what tells a copy
 * restored while the app was stopped.
 */
export const RESTORE_MARK = "restore:generation";

// Also how often the forget ledger's mark follows it at most: Workers KV takes one write a second
// to a key.
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
   * Compares the database with what this instance read from it at start, against the forget
   * ledger's mark: `null` while it holds at least that. Never rejects: a ledger that cannot be
   * read is logged and asked again by `check`.
   */
  start(): Promise<Restored | null>;
  /**
   * Takes the restore this instance counted, found at start or declared, once it is handled: a
   * start or a declaration that fails before leaves it for the next. Moves the generation past
   * what handling it committed, and keeps where the database then stands, which a declaration of
   * the same restore finds. Never rejects.
   */
  settled(): Promise<void>;
  /**
   * Reads the rows and resolves to what this instance learnt: `null` while the database holds at
   * least what it read last. Moves the generation after activity, a write to the stream since the
   * last move or `active`. Never rejects: a store that fails is logged, and the next check reads
   * again.
   */
  check(now: Date, options?: CheckRestoreOptions): Promise<Restored | null>;
  /**
   * Records a restore an operator made, or one the forget ledger tells: counted as found, so every
   * running instance learns of it, and this one first. Raises the forget ledger's mark before it
   * counts, so a mark that cannot be raised rejects with nothing counted. Counts a restore once: a
   * declaration that failed part way is finished, not counted again, and one the ledger tells
   * after another instance counted a restore this one had not read is of that one. An operator's
   * made while the database stands exactly where handling the last restore left it counts
   * nothing, unless `again`: a declaration made again and a copy taken at that moment are the same
   * database.
   */
  declare(options?: DeclareRestoreOptions): Promise<Declared>;
  /**
   * Moves the generation once more when this instance wrote since it last did, whatever the
   * interval, and raises the forget ledger's mark to it: what a stop does, so a copy taken before
   * the stop always holds less. Never rejects.
   */
  flush(): Promise<void>;
  /**
   * How many restores the instances found, as the database counts them.
   */
  found(): Promise<number>;
  /**
   * Where the database stands, for an intention to keep, once the forget ledger's mark is raised
   * to its generation: a restore counted past the mark then counts past the intention too.
   * Rejects when the mark cannot be raised.
   */
  reached(): Promise<LedgerReached>;
  /**
   * An event this instance committed, such as a forgetting: watched from now on when it is newer
   * than the one watched, so a copy taken before it is found even when the generation had not
   * moved yet.
   */
  saw(event: WatchedEvent): void;
}

export interface Declared extends Restored {
  /**
   * `false` when the database stood exactly where handling the last restore left it, and nothing
   * was counted.
   */
  readonly counted: boolean;
}

export interface WatchedEvent {
  readonly id: string;
  readonly position: number;
}

export interface DeclareRestoreOptions {
  /**
   * Whether committed entries of the forget ledger the database lost tell the restore, rather
   * than an operator.
   */
  readonly reconciled?: boolean;
  /**
   * Whether an operator's counts a restore though the database stands exactly where handling the
   * last one left it, as a copy taken at that moment does.
   */
  readonly again?: boolean;
  /**
   * A generation the database reached, which the declaration moves the generation past though the
   * mark reads lower.
   */
  readonly past?: number;
}

export interface CheckRestoreOptions {
  /**
   * Whether this instance wrote anything besides events since its last check, such as a key
   * rewrapped or a hold.
   */
  readonly active?: boolean;
}

export interface CreateRestoreWatchArgs {
  readonly checkpoints: Pick<CheckpointStore, "get" | "compareAndSet">;
  readonly events: Pick<EventStore, "lastPosition" | "readAll">;
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
 * A generation that went back, a count of restores that changed, or the newest event this
 * instance saw gone from its position, means a restore. The first instance to see the generation
 * go back, or its event gone, moves the count past every value an instance can have read, so each
 * other instance finds it changed, whether its own reading shows the restore or not. Events are
 * only ever appended, so the newest one seen stays at its position until a restore takes the
 * stream back past it: that finds a copy taken after the generation's last move, as one taken a
 * moment before a forgetting. Positions are reused after a restore, hence the id. Concurrent checks
 * share one reading.
 */
export const createRestoreWatch: CreateRestoreWatchFunction = ({
  checkpoints,
  events,
  marks,
  logger,
}) => {
  let seen: Seen | null = null;
  let movedAt = Number.NEGATIVE_INFINITY;
  let head: number | null = null;
  let pending = false;
  // While the ledger's mark could not be read, the generation stays where it is: moving it could
  // carry a copy restored while the app was stopped past the mark before it is compared.
  let unmarked = marks !== null;
  let witness: WatchedEvent | null = null;
  let checking: Promise<Restored | null> | null = null;
  // The count of a restore counted in place that `start` found, until the start went through.
  let foundAtStart = 0;
  // The count of the declaration this instance made or finished, until the restore is handled.
  let declaring = 0;
  // Whether this instance counted a restore, found or declared, that `settled` has not taken.
  let handling = false;
  // Activity of a caller that joined a check under way, for the next one.
  let joinedActive = false;
  // The highest generation whose mark could not be raised, raised again on the next check.
  let unraised = 0;
  // Whether a restore this instance counted left the generation below a mark it could not read,
  // to be moved past it, counting nothing, once it can.
  let lifting = false;

  const eventAt = async (position: number): Promise<WatchedEvent | null> => {
    if (position === 0) return null;
    const [event] = await events.readAll({ afterPosition: position - 1, limit: 1 });
    return event === undefined ? null : { id: event.id, position: event.position };
  };

  // The event this instance watches stays where it was, or another took its place.
  const witnessGone = async (): Promise<boolean> => {
    if (witness === null) return false;
    return (await eventAt(witness.position))?.id !== witness.id;
  };

  const watchHead = async (last: number): Promise<void> => {
    if (witness?.position === last) return;
    witness = await eventAt(last);
  };

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
    handling ||= first;
    return { first };
  };

  // Whether this instance takes the restore counted in place, whose count the database holds.
  const take = async (stored: Seen): Promise<boolean> => {
    const unclaimed = await checkpoints.get(RESTORE_UNCLAIMED);
    // The count it read moved past what this instance had read, so it is never 0 here.
    const taken =
      unclaimed === stored.restores &&
      (await checkpoints.compareAndSet(RESTORE_UNCLAIMED, unclaimed, 0));
    handling ||= taken;
    return taken;
  };

  // Moves the row only up, as other instances move it too.
  const advance = async (row: string, to: number): Promise<void> => {
    for (;;) {
      const at = await checkpoints.get(row);
      if (at >= to || (await checkpoints.compareAndSet(row, at, to))) return;
    }
  };

  const handledMark = async (restores: number, at: number): Promise<number> =>
    eventMark(`${restores}:${at}:${(await eventAt(at))?.id ?? ""}`);

  // Not behind the mark: a database that went back to a copy holds a generation lower than the
  // mark, which only ever follows the generation up.
  const current = async (stored: Seen): Promise<boolean> =>
    marks === null || stored.generation >= (await marks.readMark(RESTORE_MARK));

  // The database exactly where handling the last restore left it: a copy of it taken later holds
  // more, and one taken before holds less or stands behind the mark.
  const standsWhereHandled = async (stored: Seen): Promise<boolean> => {
    const handled = await checkpoints.get(RESTORE_HANDLED);
    const at = await events.lastPosition();
    return handled === (await handledMark(stored.restores, at)) && (await current(stored));
  };

  // Of two instances settling at once, the last to write read the row after the other wrote it,
  // and the database after that.
  const recordHandled = async (): Promise<void> => {
    for (;;) {
      const handled = await checkpoints.get(RESTORE_HANDLED);
      const restores = await checkpoints.get(RESTORES_FOUND);
      const mark = await handledMark(restores, await events.lastPosition());
      if (await checkpoints.compareAndSet(RESTORE_HANDLED, handled, mark)) return;
    }
  };

  // The generation a declaration moves to, past the mark, which it raises first: a mark that
  // cannot be raised fails the declaration before anything counts. A frozen or forgotten tenant's
  // ledger takes no mark, which its next start raises.
  const raiseFirst = async (stored: Seen, past = 0): Promise<number> => {
    const floor = Math.max(stored.generation, seen?.generation ?? 0, past);
    if (marks === null) return floor + 1;
    const mark = await marks.readMark(RESTORE_MARK);
    unmarked = false;
    const generation = Math.max(floor, mark) + 1;
    try {
      await marks.raiseMark(RESTORE_MARK, generation);
    } catch (error) {
      if (!isFenceError(error)) throw error;
    }
    return generation;
  };

  // Counts the declaration of `target` unless the database counted it already, and moves the
  // generation past the mark.
  const finish = async (stored: Seen, target: number, raised?: number): Promise<Declared> => {
    const generation = raised ?? (await raiseFirst(stored));
    await checkpoints.compareAndSet(RESTORES_FOUND, stored.restores, target);
    await advance(RESTORE_GENERATION, generation);
    seen = await read();
    movedAt = Number.NEGATIVE_INFINITY;
    witness = null;
    head = await events.lastPosition();
    await watchHead(head);
    declaring = target;
    handling = true;
    return { first: true, counted: true };
  };

  const raise = async (generation: number): Promise<void> => {
    if (marks === null) return;
    try {
      await marks.raiseMark(RESTORE_MARK, generation);
      if (generation >= unraised) unraised = 0;
    } catch (error) {
      unraised = Math.max(unraised, generation);
      logger.error("the forget ledger's mark could not be raised", { error });
    }
  };

  // A mark past the database's generation: the database is a copy from before it, counted past
  // `past` too.
  const compareWithMark = async (stored: Seen, past: number): Promise<Restored | null> => {
    if (marks === null) return null;
    const mark = await marks.readMark(RESTORE_MARK);
    unmarked = false;
    if (stored.generation >= mark) return null;
    const restored = await count(stored, Math.max(stored.restores, past), mark);
    await marks.raiseMark(RESTORE_MARK, seen?.generation ?? mark);
    return restored;
  };

  // The mark a restore found while running moves the generation past; one it cannot read leaves the
  // generation where the count puts it until `lift` can.
  const markPast = async (): Promise<number> => {
    if (marks === null) return 0;
    try {
      return await marks.readMark(RESTORE_MARK);
    } catch (error) {
      logger.error("the forget ledger's mark could not be read", { error });
      lifting = true;
      unmarked = true;
      return 0;
    }
  };

  // The database not gone back since the count stands below the mark only by that count.
  const lift = async (stored: Seen): Promise<void> => {
    const mark = await (marks?.readMark(RESTORE_MARK) ?? 0);
    lifting = false;
    unmarked = false;
    if (seen !== null && stored.generation >= seen.generation && stored.generation < mark) {
      await advance(RESTORE_GENERATION, mark + 1);
    }
  };

  // Moves the generation past what this instance read, and the mark with it: a copy taken before
  // holds less than both from then on.
  const move = async (from: Seen, at: number): Promise<void> => {
    const next = from.generation + 1;
    seen = from;
    if (await checkpoints.compareAndSet(RESTORE_GENERATION, from.generation, next)) {
      seen = { ...from, generation: next };
      await raise(next);
    }
    movedAt = at;
    pending = false;
  };

  const check = async (now: Date, active: boolean): Promise<Restored | null> => {
    const at = now.getTime();
    const joined = joinedActive;
    joinedActive = false;
    const [stored, last, gone] = await Promise.all([read(), events.lastPosition(), witnessGone()]);
    pending ||= active || joined || (head !== null && last !== head);
    head = last;
    // What the database reached stays what it reached: raised late, the mark still tells a copy
    // from before.
    if (unraised > 0) await raise(unraised);
    if (lifting) await lift(stored);
    else if (unmarked) {
      const restored = await compareWithMark(stored, declaring);
      if (restored !== null) return restored;
    }
    let restored: Restored | null = null;
    let current = stored;
    if (
      seen !== null &&
      (stored.generation < seen.generation || stored.restores !== seen.restores || gone)
    ) {
      // A count past what this instance read was moved by the instance that found it first.
      if (stored.restores > seen.restores) {
        restored = { first: await take(stored) };
      } else {
        // Past what the mark reached too, or the next start would find the database behind it.
        const reached = await markPast();
        restored = await count(stored, seen.restores, Math.max(seen.generation, reached));
        current = seen;
      }
      pending = true;
    }
    seen = current;
    if (restored !== null) witness = null;
    await watchHead(last);
    if (pending && !unmarked && at - movedAt >= GENERATION_INTERVAL_MS) await move(current, at);
    return restored;
  };

  const logged =
    (what: string) =>
    (error: unknown): null => {
      logger.error(what, { error });
      return null;
    };

  return {
    start: async () => {
      try {
        const stored = await read();
        head = await events.lastPosition();
        await watchHead(head);
        seen = stored;
        const declared = await checkpoints.get(RESTORE_DECLARING);
        if (declared > 0 && declared >= stored.restores) {
          // A declaration that did not finish, of a restore counted once whoever finishes it.
          if (await current(stored)) {
            await finish(stored, declared);
            return { first: true };
          }
          // A copy taken while one was under way: another restore, counted past it.
          declaring = declared;
        }
        // One counted where it was made moved the generation past the mark; one the mark tells came
        // after, as a copy of a database that held it.
        const unclaimed = await checkpoints.get(RESTORE_UNCLAIMED);
        foundAtStart = unclaimed === stored.restores ? unclaimed : 0;
        handling = foundAtStart > 0;
        const restored =
          (await compareWithMark(stored, declaring)) ?? (foundAtStart > 0 ? { first: true } : null);
        // A mark only goes up: past a restore it is already higher.
        await raise(stored.generation);
        return restored;
      } catch (error) {
        logged("the database could not be compared with the forget ledger's mark")(error);
        // A restore it found or counted before the failure is handled all the same; the mark is
        // compared on a later check.
        return handling ? { first: true } : null;
      }
    },
    settled: async () => {
      if (!handling) return;
      try {
        await checkpoints.compareAndSet(RESTORE_UNCLAIMED, foundAtStart, 0);
        await checkpoints.compareAndSet(RESTORE_DECLARING, declaring, 0);
        // What handling the restore committed, as the forgettings it applied again, is past the
        // copy: one taken before it holds less.
        const last = await events.lastPosition();
        if (seen !== null && !unmarked && last !== head) await move(seen, movedAt);
        head = last;
        await watchHead(last);
        await recordHandled();
      } catch (error) {
        logger.error("the restore handled could not be taken", { error });
      }
      foundAtStart = 0;
      declaring = 0;
      handling = false;
    },
    check: (now, { active = false } = {}) => {
      if (checking !== null) {
        joinedActive ||= active;
        return checking;
      }
      checking = check(now, active)
        .catch(logged("the database could not be checked for a restore"))
        .finally(() => {
          checking = null;
        });
      return checking;
    },
    declare: async ({ reconciled = false, again = false, past = 0 } = {}) => {
      for (;;) {
        const stored = await read();
        const declared = await checkpoints.get(RESTORE_DECLARING);
        const pending = declared > 0 && declared >= stored.restores;
        if (pending && (await current(stored))) {
          return finish(stored, declared, await raiseFirst(stored, past));
        }
        // The restore this instance counted and has not settled: the one declared.
        if (handling) return { first: true, counted: true };
        if (reconciled) {
          // Another instance counted a restore since this one read: the one the entries tell.
          if (seen !== null && stored.restores > seen.restores) {
            seen = stored;
            return { first: false, counted: true };
          }
        } else if (!again && (await standsWhereHandled(stored))) {
          return { first: true, counted: false };
        }
        // Past a declaration a copy brought back, too.
        const target = Math.max(stored.restores, declared, seen?.restores ?? 0) + 1;
        const generation = await raiseFirst(stored, past);
        // The generation first, so a declaration the row tells is never behind the mark it raised.
        await advance(RESTORE_GENERATION, generation);
        // Another declaration under way took the row first: this one finishes it.
        if (!(await checkpoints.compareAndSet(RESTORE_DECLARING, declared, target))) continue;
        return finish(stored, target, generation);
      }
    },
    flush: async () => {
      if (seen === null || unmarked) return;
      try {
        const last = await events.lastPosition();
        if (pending || (head !== null && last !== head)) {
          await move(seen, Number.NEGATIVE_INFINITY);
        } else await raise(seen.generation);
      } catch (error) {
        logger.error("the database could not be checked for a restore", { error });
      }
    },
    found: () => checkpoints.get(RESTORES_FOUND),
    reached: async () => {
      const [generation, position] = await Promise.all([
        checkpoints.get(RESTORE_GENERATION),
        events.lastPosition(),
      ]);
      await marks?.raiseMark(RESTORE_MARK, generation);
      return { generation, position };
    },
    saw: (event) => {
      if (witness === null || event.position > witness.position) {
        witness = { id: event.id, position: event.position };
      }
    },
  };
};
