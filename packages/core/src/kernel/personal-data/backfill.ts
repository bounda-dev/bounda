import type { Storage } from "../../adapter/adapter.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { Hold } from "../../adapter/storage/hold.ts";
import { isReleasedBy } from "../../adapter/storage/hold.ts";
import type { ErrorText } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { createLease, LEASE_MS } from "../shared/lease.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";
import type { AtRestSealer } from "./at-rest.ts";
import { createPause, holdAfter } from "./hold.ts";
import {
  addSealed,
  createResealBatches,
  NOTHING_SEALED,
  type ResealBatches,
  type Sealed,
} from "./reseal-batches.ts";
import { needsUpcastRewrite } from "./resealing.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

/**
 * The checkpoint rows of the backfill, named `<prefix><marks>:<row>` after the fingerprint of the
 * marks it seals for: `started`, when the first pass under them ran, in milliseconds; `position`,
 * the global position the walk has sealed through; `stores`, when it last went through the
 * scheduled commands and dead letters; `rewrite`, the position of the first event it left in an
 * older shape while an instance on other marks ran; `lease`, until when the instance walking
 * holds the walk; `held-until` and `attempts`, the hold of a walk that failed. Marks that change
 * start them all again.
 */
export const BACKFILL_PREFIX = "personal-data:backfill:";

// How long a walk that reached the head of the stream rests before it reads what came after: an
// instance still writing with older marks, as in a rolling deploy, has its events sealed this
// late.
export const BACKFILL_FOLLOW_INTERVAL_MS = 60_000;

// How long the instance walking holds the walk without renewing it.
export const BACKFILL_LEASE_MS: number = LEASE_MS;

// How long the lease of other marks must have lapsed before their rows are removed: marks some
// instance still runs renew theirs at least every lease.
export const BACKFILL_EXPIRY_MS: number = 10 * BACKFILL_FOLLOW_INTERVAL_MS;

// This instance's tally since it started, for the line it logs when the walk catches up.
const NO_TALLY = {
  events: 0,
  discarded: 0,
  unsealable: 0,
  scheduledCommands: 0,
  deadLetters: 0,
  answers: 0,
};

interface BackfillRow {
  readonly subscriber: string;
  // The fingerprint of the marks the row is of.
  readonly owner: string;
  readonly name: string;
  readonly position: number;
}

export interface PersonalDataBackfillStatus {
  readonly position: number;
  readonly caughtUp: boolean;
}

export interface PersonalDataBackfill {
  /**
   * Seals a batch of the stream past the walk's position, or, once the walk has reached the head
   * for the first time, every scheduled command and dead letter, and resolves to how many events
   * it walked past and records it resealed. Never rejects: a failure is logged and holds the walk,
   * longer after each failure in a row of any instance.
   */
  sweep(now: Date): Promise<number>;
  /**
   * Now until the walk has caught up once, unless a lease or a hold keeps it later; `null` from
   * then on, since what comes after is read on the passes the worker runs anyway.
   */
  nextDueAt(): Promise<Date | null>;
  /**
   * Where the walk stands, as the rows say: the global position it sealed through, and whether
   * it has reached the head of the stream and gone through the scheduled commands and dead
   * letters since it last sealed something written with older marks.
   */
  status(): Promise<PersonalDataBackfillStatus>;
  /**
   * Gives the lease back when this instance holds it, so another walks at once instead of waiting
   * for it to lapse. Never rejects.
   */
  release(): Promise<void>;
  /**
   * After the database went back to a copy: forgets what this instance knew of the walk, and,
   * when `first`, clears the hold the copy brought back, so the walk starts again at once from
   * where the copy stood. Never rejects.
   */
  restored(first: boolean): Promise<void>;
}

export interface CreatePersonalDataBackfillArgs {
  /**
   * The store as written: the walk reads and reseals what the store holds.
   */
  readonly storage: Pick<
    Storage,
    | "transact"
    | "checkpointStore"
    | "eventStore"
    | "personalKeys"
    | "scheduler"
    | "deadLetterStore"
    | "idempotencyStore"
  >;
  /**
   * The events as handlers read them, opened and upcast: what a process routes an event by.
   */
  readonly reading: Pick<EventStore, "readOne">;
  /**
   * What answers that name nobody are sealed under and keys are filed by.
   */
  readonly atRest: AtRestSealer | null;
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly wrapping: PersonalKeyWrapping;
  /**
   * The fingerprint of what it walks for, as `walkFingerprint` names it.
   */
  readonly marks: string;
  /**
   * The fingerprint of the marks alone, as `marksFingerprint` names them: what a remembered
   * answer sealed under them names.
   */
  readonly answerMarks: string;
  readonly batchSize: number;
  /**
   * Whether a retention is configured: a person an event names only once it is resealed has
   * their activity recorded, so the retention knows them.
   */
  readonly recordsActivity: boolean;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly errorText: ErrorText;
}

export interface CreatePersonalDataBackfillFunction {
  (args: CreatePersonalDataBackfillArgs): PersonalDataBackfill;
}

const rowsOf = (marks: string) => {
  const row = (name: string): string => `${BACKFILL_PREFIX}${marks}:${name}`;
  return {
    started: row("started"),
    position: row("position"),
    stores: row("stores"),
    rewrite: row("rewrite"),
    lease: row("lease"),
    heldUntil: row("held-until"),
    attempts: row("attempts"),
  };
};

/**
 * Walks the global stream from its first event and seals in place what each event holds in the
 * clear of a field its schema marks now, under the key of the person the marks name, who becomes
 * the event's `person`; then does the same for the payloads of scheduled commands and dead
 * letters, and for the error text of letters whose work names someone now. What a person forgot
 * before it was written is sealed under a key no store keeps, as their forgetting would have left
 * it. The walk keeps its position per set of marks, so marks that change walk again from the
 * start, and marks that do not never walk twice; past the head it keeps reading what comes after,
 * every `BACKFILL_FOLLOW_INTERVAL_MS`, and goes through the stores again after resealing any of
 * it. One instance walks at a time, under a lease; a failure holds the walk for every instance,
 * longer after each in a row. What a batch holds of one person is resealed in one transaction,
 * which a store runs one at a time with any `forget`, so their forgetting either came before, and
 * it seals what they had then under a discarded key, or after, and removes the key it sealed with.
 */
export const createPersonalDataBackfill: CreatePersonalDataBackfillFunction = ({
  storage,
  reading,
  atRest,
  aggregates,
  processes,
  wrapping,
  marks,
  answerMarks,
  batchSize,
  recordsActivity,
  clock,
  logger,
  errorText,
}) => {
  const { checkpointStore } = storage;
  const rows = rowsOf(marks);
  const pause = createPause();
  let restUntil = Number.NEGATIVE_INFINITY;
  const lease = createLease({ checkpoints: checkpointStore, row: rows.lease, clock, logger });
  let caughtUp = false;
  let tally = NO_TALLY;

  const reseal: ResealBatches = createResealBatches({
    storage,
    reading,
    aggregates,
    processes,
    wrapping,
    atRest,
    marks: answerMarks,
    logger,
    recordsActivity,
  });

  // Pages by offset, renewing the lease before each page and stopping, `null`, once another
  // instance holds it. Resealing moves no row in the order, but a row removed meanwhile, a
  // command run or a letter purged, moves those after it back past the offset: the pages are
  // read again until a reading reseals nothing, so a row skipped once is met the next time.
  const sealPages = async <Row>(
    list: (page: { readonly limit: number; readonly offset: number }) => Promise<readonly Row[]>,
    sealPage: (rows: readonly Row[]) => Promise<Sealed>,
  ): Promise<Sealed | null> => {
    let sealed = NOTHING_SEALED;
    for (;;) {
      let reading = NOTHING_SEALED;
      for (let offset = 0; ; offset += batchSize) {
        if (!(await lease.take(clock.now().getTime()))) return null;
        const page = await list({ limit: batchSize, offset });
        reading = addSealed(reading, await sealPage(page));
        if (page.length < batchSize) break;
      }
      sealed = addSealed(sealed, { ...reading, unsealable: 0 });
      if (reading.resealed === 0) return { ...sealed, unsealable: reading.unsealable };
    }
  };

  // No row reads as a hold that ended long ago, after no failure.
  const storedHold = async (): Promise<Hold> => {
    const [until, attempts] = await Promise.all([
      checkpointStore.get(rows.heldUntil),
      checkpointStore.get(rows.attempts),
    ]);
    return { until: new Date(until).toISOString(), attempts };
  };

  // A hold still running was set by another instance failing in the same round: this failure
  // waits for it rather than counting once more.
  const hold = async (at: number): Promise<void> => {
    const held = await storedHold();
    if (!isReleasedBy(held, new Date(at))) {
      restUntil = Date.parse(held.until);
      return;
    }
    const next = holdAfter({ held, at, failed: true });
    restUntil = Date.parse(next.until);
    await checkpointStore.set(rows.attempts, next.attempts);
    await checkpointStore.set(rows.heldUntil, restUntil);
  };

  const releaseHold = async (): Promise<void> => {
    if ((await checkpointStore.get(rows.attempts)) === 0) return;
    await checkpointStore.remove(rows.attempts);
    await checkpointStore.remove(rows.heldUntil);
  };

  // The backfill's rows of every set of marks, read once a pass.
  const listRows = async (): Promise<readonly BackfillRow[]> =>
    (await checkpointStore.list()).flatMap(({ subscriber, position }) => {
      if (!subscriber.startsWith(BACKFILL_PREFIX)) return [];
      const [owner = "", name = ""] = subscriber.slice(BACKFILL_PREFIX.length).split(":");
      return [{ subscriber, owner, name, position }];
    });

  // The rows of other marks whose lease lapsed long ago: no instance runs those marks any more.
  const removeStale = async (at: number, listed: readonly BackfillRow[]): Promise<void> => {
    const others = new Map<string, { lease: number; rows: string[] }>();
    for (const { subscriber, owner, name, position } of listed) {
      if (owner === marks) continue;
      const known = others.get(owner) ?? { lease: 0, rows: [] };
      others.set(owner, {
        lease: name === "lease" ? position : known.lease,
        rows: [...known.rows, subscriber],
      });
    }
    for (const other of others.values()) {
      if (at - other.lease < BACKFILL_EXPIRY_MS) continue;
      for (const row of other.rows) await checkpointStore.remove(row);
    }
  };

  // An instance on other marks renewed its lease within a follow interval: one still running, as
  // in a rolling deploy, which may not know the shape an event is rewritten in, and stores
  // commands, letters and answers as its marks say.
  const othersRunning = (at: number, listed: readonly BackfillRow[]): boolean =>
    listed.some(
      ({ owner, name, position }) =>
        owner !== marks && name === "lease" && position + BACKFILL_FOLLOW_INTERVAL_MS > at,
    );

  // Marks walked since these were: what they sealed follows them, as a field moved to another
  // category, so these walk again from the first event, as when a deploy goes back to them.
  const walkedSince = (started: number, listed: readonly BackfillRow[]): boolean =>
    listed.some(({ owner, name, position }) => {
      // Marks started at the same moment are ordered by name, so only one of them walks again.
      const later = position > started || (position === started && owner > marks);
      return owner !== marks && name === "started" && later;
    });

  const report = (): void => {
    logger.info("personal data written before its marks is sealed", { marks, ...tally });
    tally = NO_TALLY;
  };

  const warnOf = (sealed: Sealed, from: number, through: number): void => {
    if (sealed.unsealable > 0) {
      logger.warn("personal data written before its marks names no person and stays in the clear", {
        events: sealed.unsealable,
        eventTypes: [...sealed.unsealableTypes],
        afterPosition: from,
        throughPosition: through,
      });
    }
    if (sealed.discarded > 0) {
      logger.warn(
        "personal data of persons forgotten before it was marked is sealed for good; rebuild the read models that project it",
        {
          events: sealed.discarded,
          eventTypes: [...sealed.discardedTypes],
          afterPosition: from,
          throughPosition: through,
        },
      );
    }
  };

  // Resolves to how many events it walked past, `moved` when another instance moved the position
  // first. An event left in an older shape, since `rewrite` is off, is noted to walk again from.
  const walk = async (position: number, rewrite: boolean): Promise<number | "moved"> => {
    const events = await storage.eventStore.readAll({ afterPosition: position, limit: batchSize });
    const last = events.at(-1)?.position;
    if (last === undefined) return 0;
    const left = rewrite
      ? undefined
      : events.find((event) => needsUpcastRewrite({ event, aggregates }));
    if (left !== undefined) {
      const noted = await checkpointStore.get(rows.rewrite);
      if (noted === 0 || left.position < noted) {
        await checkpointStore.set(rows.rewrite, left.position);
      }
    }
    const sealed = await traced({
      errorText,
      name: "bounda.backfill",
      attributes: {
        [ATTRIBUTES.afterPosition]: position,
        [ATTRIBUTES.eventCount]: events.length,
      },
      run: () => reseal.events(events, rewrite),
    });
    if (!(await checkpointStore.compareAndSet(rows.position, position, last))) return "moved";
    warnOf(sealed, position, last);
    tally = {
      ...tally,
      events: tally.events + sealed.resealed,
      discarded: tally.discarded + sealed.discarded,
      unsealable: tally.unsealable + sealed.unsealable,
    };
    if (sealed.resealed > 0) {
      logger.debug("personal data written before its marks sealed", {
        events: sealed.resealed,
        afterPosition: position,
        throughPosition: last,
      });
      // An event in the clear past the stores' pass was written with older marks, which may have
      // stored commands and letters in the clear too.
      if ((await checkpointStore.get(rows.stores)) > 0) await checkpointStore.remove(rows.stores);
    }
    return events.length;
  };

  // `null` when another instance took the walk meanwhile. While an instance on other marks runs,
  // what it stores is not as these marks say: the stores are gone through again on each pass.
  const sealStores = async (
    at: number,
    started: number,
    others: boolean,
  ): Promise<number | null> => {
    const commands = await sealPages(
      (page) => storage.scheduler.list(page),
      (entries) => reseal.commands(entries),
    );
    if (commands === null) return null;
    const letters = await sealPages(
      (page) => storage.deadLetterStore.list(page),
      (page) => reseal.letters(page, started),
    );
    if (letters === null) return null;
    const answers = await sealPages(
      (page) => storage.idempotencyStore.list({ now: clock.now(), ...page }),
      (records) => reseal.answers(records, clock.now()),
    );
    if (answers === null) return null;
    tally = {
      ...tally,
      discarded: tally.discarded + commands.discarded + letters.discarded,
      unsealable: tally.unsealable + commands.unsealable + letters.unsealable,
      scheduledCommands: tally.scheduledCommands + commands.resealed,
      deadLetters: tally.deadLetters + letters.resealed,
      answers: tally.answers + answers.resealed,
    };
    if (commands.unsealable + letters.unsealable > 0) {
      logger.warn("commands stored before their marks name no person and stay in the clear", {
        scheduledCommands: commands.unsealable,
        deadLetters: letters.unsealable,
        commandTypes: [...new Set([...commands.unsealableTypes, ...letters.unsealableTypes])],
      });
    }
    if (!others) await checkpointStore.set(rows.stores, at);
    return commands.resealed + letters.resealed + answers.resealed;
  };

  // What comes after the head once it caught up is written sealed, but by an instance on older
  // marks, which takes the stores back to not caught up.
  const status = async (): Promise<PersonalDataBackfillStatus> => {
    const [position, stores, rewrite] = await Promise.all([
      checkpointStore.get(rows.position),
      checkpointStore.get(rows.stores),
      checkpointStore.get(rows.rewrite),
    ]);
    return { position, caughtUp: stores > 0 && rewrite === 0 };
  };

  // Once no instance on other marks runs, the walk goes back to the first event it left in an
  // older shape; rewriting it takes the stores back to not caught up, as any event resealed does.
  const rewind = async (position: number): Promise<number | "moved"> => {
    const from = await checkpointStore.get(rows.rewrite);
    if (from === 0) return position;
    const back = Math.min(position, from - 1);
    if (!(await checkpointStore.compareAndSet(rows.position, position, back))) return "moved";
    await checkpointStore.remove(rows.rewrite);
    return back;
  };

  const pass = async (now: Date): Promise<number> => {
    const at = now.getTime();
    const heldUntil = await checkpointStore.get(rows.heldUntil);
    if (heldUntil > at) {
      restUntil = heldUntil;
      return 0;
    }
    if (!(await lease.take(at))) return 0;
    const listed = await listRows();
    let started = await checkpointStore.get(rows.started);
    if (started !== 0 && walkedSince(started, listed)) {
      for (const row of [rows.position, rows.stores, rows.rewrite, rows.started]) {
        await checkpointStore.remove(row);
      }
      caughtUp = false;
      started = 0;
    }
    if (started === 0) {
      await checkpointStore.compareAndSet(rows.started, 0, at);
      started = await checkpointStore.get(rows.started);
    }
    const others = othersRunning(at, listed);
    const position = others
      ? await checkpointStore.get(rows.position)
      : await rewind(await checkpointStore.get(rows.position));
    if (position === "moved") return 0;
    const walked = await walk(position, !others);
    if (walked === "moved") return 0;
    if (walked >= batchSize) return walked;
    let stored = 0;
    if ((await checkpointStore.get(rows.stores)) === 0) {
      const sealed = await sealStores(at, started, others);
      if (sealed === null) return walked;
      stored = sealed;
      if (!others) report();
    }
    caughtUp = !others && (await checkpointStore.get(rows.rewrite)) === 0;
    restUntil = at + BACKFILL_FOLLOW_INTERVAL_MS;
    await releaseHold();
    await removeStale(at, listed);
    return walked + stored;
  };

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at) || at < restUntil) return 0;
      try {
        const done = await pass(now);
        pause.resume();
        return done;
      } catch (error) {
        logger.error("personal data written before its marks could not be sealed", {
          error,
        });
        await hold(at).catch((holdError: unknown) => {
          pause.pause(at);
          logger.error("personal data backfill could not be held", { error: holdError });
        });
        return 0;
      }
    },
    // A walk that caught up once, here, on another instance or before a restart, wakes nothing:
    // what comes after is written sealed, but by an instance on older marks, which the passes
    // the worker runs anyway follow.
    nextDueAt: async () => {
      if (caughtUp) return null;
      caughtUp = (await status()).caughtUp;
      if (caughtUp) return null;
      return new Date(
        pause.notBefore(Math.max(clock.now().getTime(), restUntil, lease.heldElsewhereUntil())),
      );
    },
    status,
    release: lease.release,
    restored: async (first) => {
      caughtUp = false;
      restUntil = Number.NEGATIVE_INFINITY;
      pause.resume();
      lease.reset();
      if (!first) return;
      await releaseHold().catch((error: unknown) => {
        logger.error("personal data backfill's hold could not be cleared", { error });
      });
    },
  };
};
