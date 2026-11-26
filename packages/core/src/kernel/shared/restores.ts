import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type {
  ForgetLedger,
  ForgetLedgerMark,
  LedgerReached,
} from "../../adapter/storage/forget-ledger.ts";
import { isFenceError } from "../../adapter/storage/tenant-fence.ts";
import type { Clock } from "../../contracts/clock.ts";
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

/**
 * The forget ledger's mark the count of restores is raised to: a copy brings back the count it
 * held, and a restore counted after it still counts past every restore found before.
 */
export const RESTORE_COUNT_MARK = "restore:count";

/**
 * The forget ledger's mark raised, on a ledger whose reads lag, to the count of restores a recount
 * moved to, at the time it did: what it counted of the values counted more than once before then.
 */
export const RESTORE_RECOUNTED_MARK = "restore:recounted";

/**
 * The time of the latest restore counted, on a database whose forget ledger's reads lag: a mark
 * raised before it is what that restore, or one before, left behind, and tells no other.
 */
export const RESTORE_COVERED = "runtime:restore-covered";

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
  readonly marks: Pick<
    ForgetLedger,
    "readMark" | "raiseMark" | "pruneMarks" | "visibilityDelayMs"
  > | null;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
}

export interface CreateRestoreWatchFunction {
  (args: CreateRestoreWatchArgs): RestoreWatch;
}

interface Seen {
  readonly generation: number;
  readonly restores: number;
}

const iso = (at: number): string => new Date(at).toISOString();

const timeOf = ({ raisedAt }: ForgetLedgerMark): number => Date.parse(raisedAt);

const highestOf = (points: readonly ForgetLedgerMark[]): number =>
  points.reduce((highest, { value }) => Math.max(highest, value), 0);

// A value raised before a lower one: the database held it, then less.
const dropped = (points: readonly ForgetLedgerMark[]): boolean => {
  let highest = 0;
  let before = 0;
  let at = Number.NEGATIVE_INFINITY;
  for (const point of [...points].sort((a, b) => timeOf(a) - timeOf(b))) {
    if (timeOf(point) > at) {
      before = highest;
      at = timeOf(point);
    }
    if (point.value < before) return true;
    highest = Math.max(highest, point.value);
  }
  return false;
};

// The values raised from `from`, included, to `to`, left out.
const between = (
  points: readonly ForgetLedgerMark[],
  from: number,
  to: number,
): readonly ForgetLedgerMark[] =>
  points.filter((point) => timeOf(point) >= from && timeOf(point) < to);

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
  clock,
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
  // The highest count of restores the ledger told or took from this instance, and the highest it
  // could not take, raised again on the next check.
  let countMark = 0;
  let uncounted = 0;
  let uncountedAt = 0;
  // The counts this instance raised, as the ledger keeps them, which its reads may not show yet.
  const ownCounts: ForgetLedgerMark[] = [];
  // Whether a mark that could not be read was said, until it can be again.
  let unreadableSaid = false;
  // Whether a restore this instance counted left the generation below a mark it could not read,
  // to be moved past it, counting nothing, once it can.
  let lifting = false;
  // On a ledger whose reads lag, a mark raised before this instance started may show only that
  // long after it. The start raises the generation it read, at its time: once the reads show every
  // mark raised before, a value raised before a lower one tells a restore however far the
  // generation moved since, and until then only the marks raised since are compared.
  const delayMs = marks?.visibilityDelayMs ?? 0;
  const lagging = marks !== null && delayMs > 0;
  let startedAt: number | null = null;
  let judged = !lagging;
  // The generation the start read, until the ledger takes it: the generation stays where it is
  // meanwhile, so a look compares the database as the start found it.
  let reading: Seen | null = null;
  // When the highest value the ledger did not take was raised, as it is raised again.
  let unraisedAt = 0;
  // The marks the last read showed.
  let shown: readonly ForgetLedgerMark[] = [];

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

  const raiseAt = (name: string, value: number, at: number): Promise<void> =>
    (marks as NonNullable<typeof marks>).raiseMark(name, { value, raisedAt: iso(at) });

  // Lets go of what no later look compares; a ledger that keeps the highest value alone has
  // nothing to let go.
  const pruneBefore = async (names: readonly string[], at: number): Promise<void> => {
    const prune = marks?.pruneMarks;
    if (prune === undefined) return;
    try {
      for (const name of names) await prune.call(marks, name, iso(at));
    } catch (error) {
      logger.error("the forget ledger's marks could not be pruned", { error });
    }
  };

  // Until the marks raised before this instance started are judged, a ledger whose reads lag
  // compares only the ones raised since with the database.
  const comparable = (points: readonly ForgetLedgerMark[]): number =>
    judged || startedAt === null
      ? highestOf(points)
      : highestOf(between(points, startedAt, Number.POSITIVE_INFINITY));

  const read = async (): Promise<Seen> => {
    const [generation, restores] = await Promise.all([
      checkpoints.get(RESTORE_GENERATION),
      checkpoints.get(RESTORES_FOUND),
    ]);
    return { generation, restores };
  };

  // The count of restores goes to the ledger too, which a copy does not take back. Raised again,
  // it keeps the time it was counted at: two times for one value are two restores.
  const raiseCount = async (value: number, at = clock.now().getTime()): Promise<void> => {
    if (marks === null) return;
    if (!ownCounts.some((own) => own.value === value && timeOf(own) === at)) {
      ownCounts.push({ value, raisedAt: iso(at) });
    }
    try {
      await raiseAt(RESTORE_COUNT_MARK, value, at);
      if (value >= uncounted) uncounted = 0;
    } catch (error) {
      if (value > uncounted) uncountedAt = at;
      uncounted = Math.max(uncounted, value);
      logger.error("the forget ledger's count of restores could not be raised", { error });
      return;
    }
    if (lagging && judged) await pruneBefore([RESTORE_COUNT_MARK], at - delayMs);
  };

  // A restore counted, by this instance or another, tells every mark raised before it: what a
  // look on a ledger whose reads lag compares with the database starts after it.
  const cover = async (): Promise<void> => {
    if (lagging) await advance(RESTORE_COVERED, clock.now().getTime());
  };

  // Counts the restore unless another instance did first, past every restore the ledger counted,
  // and moves the generation past `floor`, so the copy's own value never reads as current again.
  const count = async (stored: Seen, past: number, floor: number): Promise<Restored> => {
    const counted = Math.max(past, countMark) + 1;
    const first = await checkpoints.compareAndSet(RESTORES_FOUND, stored.restores, counted);
    const restores = first ? counted : await checkpoints.get(RESTORES_FOUND);
    await cover();
    // Raised by the instance that counted it: once more, at another time, it would read as another.
    if (first || !lagging) await raiseCount(restores);
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
    if (taken) {
      await cover();
      await countedInPlace(stored.restores);
    }
    return taken;
  };

  // A restore counted in place, from the copy's own count, which knew of none of the restores the
  // ledger counted since: moved past them once taken, so a start that fails before leaves the
  // ledger's count as it was for the next.
  const countedInPlace = async (restores: number): Promise<void> => {
    if (countMark < restores) return raiseCount(restores);
    await checkpoints.compareAndSet(RESTORES_FOUND, restores, countMark + 1);
    await raiseCount(countMark + 1);
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
    marks === null || stored.generation >= comparable(await marks.readMark(RESTORE_MARK));

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
    const [points, counted] = await Promise.all([
      marks.readMark(RESTORE_MARK),
      marks.readMark(RESTORE_COUNT_MARK),
    ]);
    countMark = Math.max(countMark, highestOf(counted));
    unmarked = false;
    // Past every mark, judged or not: moving further than needed counts nothing.
    const generation = Math.max(floor, highestOf(points)) + 1;
    try {
      await raiseAt(RESTORE_MARK, generation, clock.now().getTime());
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
    await cover();
    await raiseCount(target);
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

  // Raised again, a value keeps the time it was first raised at: later, it would read as the
  // database holding less than what was raised before.
  const raise = async (generation: number, at = clock.now().getTime()): Promise<void> => {
    if (marks === null) return;
    try {
      await raiseAt(RESTORE_MARK, generation, at);
      if (generation >= unraised) unraised = 0;
    } catch (error) {
      if (generation > unraised) unraisedAt = at;
      unraised = Math.max(unraised, generation);
      logger.error("the forget ledger's mark could not be raised", { error });
      return;
    }
    // Once judged, a value raised supersedes every lower one raised before it; of those older than
    // a read may lag, the highest stays, which a start reads at once.
    if (lagging && judged) await pruneBefore([RESTORE_MARK], at - delayMs);
  };

  const raiseReading = async (): Promise<void> => {
    if (reading === null) return;
    try {
      await raiseAt(RESTORE_MARK, reading.generation, startedAt as number);
      reading = null;
    } catch (error) {
      logger.error("the forget ledger's mark could not be raised", { error });
    }
  };

  // Of the marks raised since the latest restore counted, what tells a restore nobody counted: a
  // value raised before this instance started above the generation the database holds, or one
  // raised before a lower one. Resolves the highest, which the count moves the generation past.
  const unexplained = async (
    stored: Seen,
    points: readonly ForgetLedgerMark[],
  ): Promise<number | null> => {
    const since = between(points, await checkpoints.get(RESTORE_COVERED), Number.POSITIVE_INFINITY);
    // One instance at a time writes a ledger whose reads lag: what was raised at the time it
    // started was raised before.
    const before = highestOf(between(since, 0, (startedAt as number) + 1));
    return before > stored.generation || dropped(since) ? highestOf(since) : null;
  };

  // Counted as found at start, from what the reads show already.
  const atOnce = async (stored: Seen): Promise<Restored | null> => {
    const evidence = await unexplained(stored, shown);
    if (evidence === null) return null;
    const restored = await count(stored, Math.max(stored.restores, declaring), evidence);
    await raise(seen?.generation ?? evidence + 1);
    return restored;
  };

  // Once the reads show every mark raised before this instance started, they are compared with the
  // database, the start's reading among them; then the generation goes past every one, counting
  // nothing more.
  const judge = async (stored: Seen): Promise<Restored | null> => {
    const evidence = await unexplained(stored, between(shown, 0, (startedAt as number) + 1));
    if (evidence !== null) {
      const past = Math.max(stored.restores, seen?.restores ?? 0, declaring);
      const restored = await count(stored, past, evidence);
      await raise(seen?.generation ?? evidence + 1);
      return restored;
    }
    const before = highestOf(between(shown, 0, (startedAt as number) + 1));
    if (stored.generation < before) {
      await advance(RESTORE_GENERATION, before + 1);
      await raise(before + 1);
    }
    judged = true;
    await recount();
    await pruneBefore([RESTORE_MARK, RESTORE_COUNT_MARK], startedAt as number);
    return null;
  };

  // A restore counted while the reads did not show one counted a moment before took the same
  // value: each value counted again since the last recount is a restore more, which the database's
  // count goes past. Every count raised before it shows by now, or is this instance's own.
  const recount = async (): Promise<void> => {
    const ledger = marks as NonNullable<typeof marks>;
    const [counted, recounted] = await Promise.all([
      ledger.readMark(RESTORE_COUNT_MARK),
      ledger.readMark(RESTORE_RECOUNTED_MARK),
    ]);
    const counts = [
      ...counted,
      ...ownCounts.filter(
        (own) =>
          !counted.some(({ value, raisedAt }) => value === own.value && raisedAt === own.raisedAt),
      ),
    ].sort((a, b) => timeOf(a) - timeOf(b));
    const since = Math.max(...recounted.map(timeOf), Number.NEGATIVE_INFINITY);
    const again = counts.filter(
      (count, index) =>
        timeOf(count) > since && counts.slice(0, index).some(({ value }) => value === count.value),
    ).length;
    if (again === 0) return;
    const target = highestOf(counts) + again;
    await advance(RESTORES_FOUND, target);
    if (seen !== null) seen = { ...seen, restores: Math.max(seen.restores, target) };
    countMark = Math.max(countMark, target);
    const at = clock.now().getTime();
    await raiseCount(target, at);
    try {
      await raiseAt(RESTORE_RECOUNTED_MARK, target, at);
    } catch (error) {
      logger.error("the forget ledger's recount of restores could not be raised", { error });
    }
  };

  // The mark, read before the database: raised only once the database held it, it is never past
  // what a database read after it holds, unless that database went back. `null` without a ledger,
  // or when the ledger cannot answer, which is said once until it can.
  const markNow = async (): Promise<number | null> => {
    if (marks === null) return null;
    try {
      const [points, counted] = await Promise.all([
        marks.readMark(RESTORE_MARK),
        marks.readMark(RESTORE_COUNT_MARK),
      ]);
      countMark = Math.max(countMark, highestOf(counted));
      unmarked = false;
      unreadableSaid = false;
      shown = points;
      return comparable(points);
    } catch (error) {
      if (!unreadableSaid) logger.error("the forget ledger's mark could not be read", { error });
      unreadableSaid = true;
      unmarked = true;
      return null;
    }
  };

  // A mark past the database's generation: the database is a copy from before it, counted past
  // `past` too.
  const compareWithMark = async (
    stored: Seen,
    past: number,
    mark: number,
  ): Promise<Restored | null> => {
    if (stored.generation >= mark) return null;
    const restored = await count(stored, Math.max(stored.restores, past), mark);
    await raise(seen?.generation ?? mark);
    return restored;
  };

  // Past the mark a restore this instance counted while it could not read it, counting nothing: a
  // database gone back since is counted past the mark by the same check, from what it read before.
  const lift = async (mark: number): Promise<void> => {
    lifting = false;
    await advance(RESTORE_GENERATION, mark + 1);
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
    const mark = await markNow();
    const [initial, last, gone] = await Promise.all([read(), events.lastPosition(), witnessGone()]);
    let stored = initial;
    pending ||= active || joined || (head !== null && last !== head);
    head = last;
    // What the database reached stays what it reached: raised late, the mark still tells a copy
    // from before.
    if (unraised > 0) await raise(unraised, unraisedAt);
    if (reading !== null) await raiseReading();
    if (uncounted > 0) await raiseCount(uncounted, uncountedAt);
    // Every mark raised before this instance started shows by now.
    if (!judged && mark !== null && startedAt !== null && at >= startedAt + delayMs) {
      const found = await judge(stored);
      if (found !== null) {
        witness = null;
        await watchHead(last);
        return found;
      }
      // As the judgment left it, moved past every mark raised before and counting what it learnt.
      stored = await read();
    } else if (judged && lagging && mark !== null) {
      // A value raised before a lower one since: the database went back and the look that read it
      // counted nothing.
      const evidence = await unexplained(stored, shown);
      if (evidence !== null) {
        const restored = await count(stored, Math.max(declaring, seen?.restores ?? 0), evidence);
        await raise(seen?.generation ?? evidence + 1);
        witness = null;
        await watchHead(last);
        return restored;
      }
    }
    const lifted = lifting && mark !== null;
    if (lifted) await lift(mark);
    // Behind the mark, whatever this instance read: a copy from before what an instance, a stop or
    // a count told the ledger of, though another restore was counted since this instance read.
    if (!lifted && mark !== null) {
      const behind = await compareWithMark(stored, Math.max(declaring, seen?.restores ?? 0), mark);
      if (behind !== null) {
        witness = null;
        await watchHead(last);
        return behind;
      }
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
        // As the take left them, or another instance's count lifted past the ledger's.
        current = await read();
      } else {
        // Past what the mark reached too, or the next start would find the database behind it;
        // one it cannot read leaves the generation where the count puts it until `lift` can.
        lifting ||= marks !== null && mark === null;
        // A mark the database is behind was compared above: the database holds it.
        restored = await count(stored, seen.restores, seen.generation);
        current = seen;
      }
      pending = true;
    }
    seen = current;
    if (restored !== null) witness = null;
    await watchHead(last);
    if (pending && !unmarked && reading === null && at - movedAt >= GENERATION_INTERVAL_MS) {
      await move(current, at);
    }
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
        startedAt = clock.now().getTime();
        const mark = await markNow();
        const stored = await read();
        head = await events.lastPosition();
        await watchHead(head);
        seen = stored;
        const declared = await checkpoints.get(RESTORE_DECLARING);
        if (declared > 0 && declared >= stored.restores) {
          // A declaration that did not finish, of a restore counted once whoever finishes it.
          if (marks === null || (mark !== null && stored.generation >= mark)) {
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

        // A mark that cannot be read is compared on a later check.
        const restored =
          (mark === null
            ? null
            : lagging
              ? await atOnce(stored)
              : await compareWithMark(stored, declaring, mark)) ??
          (foundAtStart > 0 ? { first: true } : null);
        // A mark only goes up: past a restore it is already higher. On a ledger whose reads lag,
        // what the start read is raised at its time, whatever the start counted.
        if (lagging) {
          reading = stored;
          await raiseReading();
        } else if (mark !== null) await raise(stored.generation);
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
        if (
          foundAtStart > 0 &&
          (await checkpoints.compareAndSet(RESTORE_UNCLAIMED, foundAtStart, 0))
        ) {
          await countedInPlace(foundAtStart);
        }
        await checkpoints.compareAndSet(RESTORE_DECLARING, declaring, 0);
        // What handling the restore committed, as the forgettings it applied again, is past the
        // copy: one taken before it holds less.
        const last = await events.lastPosition();
        if (seen !== null && !unmarked && reading === null && last !== head) {
          await move(seen, movedAt);
        }
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
        const generation = await raiseFirst(stored, past);
        // Past a declaration a copy brought back, and every restore the ledger counted, too.
        const target = Math.max(stored.restores, declared, seen?.restores ?? 0, countMark) + 1;
        // The generation first, so a declaration the row tells is never behind the mark it raised.
        await advance(RESTORE_GENERATION, generation);
        // Another declaration under way took the row first: this one finishes it.
        if (!(await checkpoints.compareAndSet(RESTORE_DECLARING, declared, target))) continue;
        return finish(stored, target, generation);
      }
    },
    flush: async () => {
      if (seen === null) return;
      try {
        const mark = await markNow();
        const [stored, last, gone] = await Promise.all([
          read(),
          events.lastPosition(),
          witnessGone(),
        ]);
        // Gone back since this instance read it, and no look will count it before the stop: the
        // mark goes past what it read, so the next look finds the database behind it. A count past
        // what it read is of that restore, counted by another instance, as a check takes it.
        if ((gone || stored.generation < seen.generation) && stored.restores <= seen.restores) {
          await raise(Math.max(seen.generation, stored.generation) + 1);
          return;
        }
        if (mark === null && marks !== null) return;
        if (lifting && mark !== null) {
          await lift(mark);
          return;
        }
        // Behind a mark this instance never compared: moved, it could pass it, and the next look
        // would find nothing.
        if (mark !== null && stored.generation < mark) return;
        // Not moved before the ledger took what the start read: the next look compares it.
        if (reading === null && (pending || (head !== null && last !== head))) {
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
      if (marks !== null) await raiseAt(RESTORE_MARK, generation, clock.now().getTime());
      return { generation, position };
    },
    saw: (event) => {
      if (witness === null || event.position > witness.position) {
        witness = { id: event.id, position: event.position };
      }
    },
  };
};
