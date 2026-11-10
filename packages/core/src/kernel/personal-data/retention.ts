import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { Hold } from "../../adapter/storage/hold.ts";
import { isReleasedBy } from "../../adapter/storage/hold.ts";
import type {
  PersonActivity,
  PersonStore,
  StoredPerson,
} from "../../adapter/storage/person-store.ts";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type DueKey,
  type PersonalKeyStore,
} from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { type Retention, retentionEnd, retentionStart } from "../../contracts/duration.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import {
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
} from "../../modules/bounda-events.ts";
import type { Subscriber } from "../dispatch/delivery.ts";
import { createLease } from "../shared/lease.ts";
import { isActivity } from "./activity.ts";
import { formatRetention, type PersonalCategories, type PersonalCategory } from "./categories.ts";
import { type ForgetScope, forgetWithin, logForgotten, STALE_INTENTION } from "./forget.ts";
import { createPause, holdAfter } from "./hold.ts";
import type { ForgetIntentions } from "./intention.ts";
import type { RetentionDueFunction } from "./reconciliation.ts";
import { transactRetrying } from "./transact.ts";

export const RETENTION_SUBSCRIBER: "retention" = "retention";

// How many persons, and how many keys of each category, a pass of the worker forgets at most.
export const RETENTION_SWEEP_LIMIT = 50;

/**
 * The checkpoint row of the lease the sweep runs under: one instance forgets at a time.
 */
export const RETENTION_LEASE = "personal-data:retention:lease";

/**
 * Where one retention stands: the app's, of persons as a whole, under the default category, or a
 * declared category's, of its keys. How many are idle past it now, held ones included, and when
 * the next one comes due.
 */
export interface CategoryRetentionStatus {
  readonly category: string;
  /**
   * As `app/personal-data.ts` writes it, `"30d"` or `"6y"`.
   */
  readonly retention: string;
  readonly due: number;
  readonly nextDueAt: string | null;
}

/**
 * Where the retention stands: each retention set, and how many keys a forgetting kept that no
 * legal obligation keeps any more, which the sweep destroys at once.
 */
export interface RetentionStatus {
  readonly categories: readonly CategoryRetentionStatus[];
  readonly keptBeyond: number;
}

// Asked only of the runtime's own events, once `isActivity` said no.
const isForget = (event: StoredEvent): boolean => event.type === PERSONAL_DATA_FORGOTTEN_EVENT;

// A forgetting of the person as a whole, as every one recorded before categories was; one of some
// categories leaves the row as it was.
const isWholeForget = (event: StoredEvent): boolean =>
  isForget(event) && (event.payload as PersonalDataForgottenPayload).whole !== false;

// What a `PersonalDataForgotten` says of its person; their last activity stays as it was.
const forgettingOf = (event: StoredEvent & { readonly person: string }): PersonActivity => ({
  person: event.person,
  position: event.position,
  forgottenAt: event.timestamp,
});

const rowIsCurrent = async (
  eventStore: EventStore,
  person: string,
  through: number,
  batchSize: number,
): Promise<boolean> => {
  for (let after = through; ; ) {
    const events = await eventStore.readByPerson({
      person,
      afterPosition: after,
      limit: batchSize,
    });
    if (events.some((event) => isActivity(event) || isForget(event))) return false;
    const last = events[batchSize - 1];
    if (last === undefined) return true;
    after = last.position;
  }
};

const isIdle = (row: StoredPerson | null): row is StoredPerson =>
  row !== null && row.restrictedSince === null && row.forgottenAt === null;

export interface RetentionDueArgs {
  readonly categories: PersonalCategories;
  readonly batchSize: number;
  /**
   * Where the retention subscriber keeps how far its records reach.
   */
  readonly checkpoints: CheckpointStore;
}

export interface RetentionDueOfFunction {
  (args: RetentionDueArgs): RetentionDueFunction;
}

const isPast = (lastActiveAt: string | null, retention: Retention | null, now: Date): boolean =>
  lastActiveAt !== null &&
  retention !== null &&
  retentionEnd(Date.parse(lastActiveAt), retention) <= now.getTime();

/**
 * Whether the retention would forget at `now` the person as a whole, past the app's retention, or
 * each of the keys given, past its category's, as a sweep decides it in the transaction that
 * forgets them.
 */
export const retentionDueOf: RetentionDueOfFunction =
  ({ categories, batchSize, checkpoints }) =>
  async (stores, personId, now, keys) => {
    const row = await stores.persons.get(personId);
    const past =
      keys === null
        ? isIdle(row) &&
          isPast(row.lastActiveAt, categories.of(DEFAULT_PERSONAL_CATEGORY)?.retention ?? null, now)
        : (row?.restrictedSince ?? null) === null &&
          keys.every(({ category, lastActiveAt }) =>
            isPast(lastActiveAt, categories.of(category)?.retention ?? null, now),
          );
    if (!past) return false;
    const through = await checkpoints.get(RETENTION_SUBSCRIBER);
    return rowIsCurrent(stores.eventStore, personId, through, batchSize);
  };

export interface CreateRetentionSubscriberArgs {
  readonly persons: PersonStore;
  readonly keys: Pick<PersonalKeyStore, "touch">;
}

export interface CreateRetentionSubscriberFunction {
  (args: CreateRetentionSubscriberArgs): Subscriber;
}

/**
 * Follows the global stream from its first event and records, per person an event names, their
 * last activity, an event of the app's aggregates, on their row and on each of their keys in
 * force, and their last forgetting as a whole, which activity after it clears; the runtime's
 * other events on `bounda:<personId>` change nothing. One write per person and batch, which the
 * stores ignore for a batch they recorded already, so a batch delivered twice, or from the start
 * again, leaves the same rows.
 */
export const createRetentionSubscriber: CreateRetentionSubscriberFunction = ({
  persons,
  keys,
}) => ({
  name: RETENTION_SUBSCRIBER,
  kind: "retention",
  process: async (events) => {
    const recorded = new Map<string, PersonActivity>();
    for (const event of events) {
      const { person } = event;
      if (person === null) continue;
      const known = recorded.get(person);
      if (isActivity(event)) {
        recorded.set(person, {
          person,
          position: event.position,
          lastActiveAt: event.timestamp,
          forgottenAt: null,
        });
      } else if (isWholeForget(event)) {
        recorded.set(person, { ...known, ...forgettingOf({ ...event, person }) });
      }
    }
    for (const activity of recorded.values()) {
      await persons.record(activity);
      if (activity.lastActiveAt !== undefined) {
        await keys.touch(activity.person, activity.lastActiveAt);
      }
    }
    return events.length;
  },
});

export interface RetentionSweep {
  /**
   * Forgets, with `reason: "retention"`, up to `RETENTION_SWEEP_LIMIT` persons idle past the app's
   * retention at `now` and not held, as a whole, as many keys of each declared category idle past
   * that category's retention, and as many keys a forgetting kept that no legal obligation keeps
   * any more, and resolves to how many forgettings it made. Never rejects:
   * a person or a key it could not forget is logged and held, longer after each failure.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next person or key the retention may forget becomes due, a held one not before its
   * hold ends; `null` when there is none.
   */
  nextDueAt(): Promise<Date | null>;
  status(): Promise<RetentionStatus>;
  /**
   * Gives the lease back when this instance holds it. Never rejects.
   */
  release(): Promise<void>;
  /**
   * After the database went back to a copy: forgets what this instance knew of the sweep, and,
   * when `first`, clears the holds of the persons the copy brought back. Never rejects.
   */
  restored(first: boolean): Promise<void>;
}

export interface CreateRetentionSweepArgs {
  readonly storage: Storage;
  readonly intentions: ForgetIntentions;
  readonly categories: PersonalCategories;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  readonly batchSize: number;
  /**
   * Called with each person a forgetting covered, once it is committed.
   */
  readonly forgotten?: (personId: string) => void;
}

export interface CreateRetentionSweepFunction {
  (args: CreateRetentionSweepArgs): RetentionSweep;
}

type Outcome = "forgotten" | "skipped" | "undone";

// Where a forgetting is checked: on the store before its intention, and again in its transaction.
type CheckedStores = Pick<StorageTransaction, "persons" | "personalKeys" | "eventStore">;

interface Swept {
  readonly forgotten: number;
  readonly kept: boolean;
  // Another instance took the lease: the pass ends.
  readonly lost: boolean;
}

// What a list of things to forget is read through: persons idle past the app's retention, or the
// keys of one category idle past its own.
interface Sweepable<Due> {
  // The latest last activity due at `at`; every one is when omitted.
  activeBefore(at: number): Date | undefined;
  // When one listed comes due; `null` for one with no activity recorded.
  deadlineOf(due: Due): number | null;
  list(args: {
    readonly activeBefore?: Date;
    readonly releasedBy?: Date;
    readonly limit: number;
  }): Promise<readonly Due[]>;
  // How many `list` lists with `activeBefore`, whatever their holds.
  count(activeBefore: Date | undefined): Promise<number>;
  nextHoldEnd(after: Date): Promise<Date | null>;
  holdOf(due: Due): Hold | null;
  // Resolves `undone` for one whose record is behind, left for a later pass, and `skipped` for
  // one restricted, or forgotten by another instance, since the list was read.
  forget(due: Due, through: number): Promise<Outcome>;
  hold(due: Due, hold: Hold): Promise<void>;
  // For the log.
  describe(due: Due): Readonly<Record<string, unknown>>;
}

interface Runner {
  sweep(now: Date, through: () => Promise<number>): Promise<Swept>;
  nextDue(now: Date): Promise<number>;
  // For a retention of the app or a category; the keys kept beyond a legal obligation have none.
  readonly status?: (now: Date) => Promise<CategoryRetentionStatus>;
}

/**
 * The records lag behind the stream by what the subscriber has not recorded yet, so a person, or
 * a key in force, is forgotten only when no event past its checkpoint names them as active or
 * forgotten already, read in the transaction that forgets them, with their restriction: a person
 * active a moment ago is not forgotten for an activity the record does not show yet, and of two
 * instances sweeping one person, the one whose append conflicts reads the other's forgetting on
 * its retry and stops. A key kept past a forgetting follows no activity, so it needs no such
 * check. `storage` is the store as written: the sweep reads no personal field.
 */
export const createRetentionSweep: CreateRetentionSweepFunction = ({
  storage,
  intentions,
  categories,
  ids,
  clock,
  logger,
  concurrencyRetries,
  batchSize,
  forgotten: onForgotten,
}) => {
  // Resolves `undone` for one whose record is behind, or who was given a key since the intention,
  // left for a later pass, and `skipped` for one restricted, or forgotten by another instance,
  // since the list was read. Both are decided once before the intention, so one plainly left
  // leaves none, and again in the transaction; an intention it then leaves is committed again
  // only if the retention would still forget it.
  const forgetting = async (
    personId: string,
    scope: ForgetScope,
    check: (stores: CheckedStores) => Promise<"go" | Exclude<Outcome, "forgotten">>,
    whole: boolean,
  ): Promise<Outcome> => {
    const before = await check(storage);
    if (before !== "go") return before;
    const intention = await intentions.intend({
      personId,
      reason: "retention",
      scope,
      keys: storage.personalKeys,
    });
    const correlationId = ids.next();
    const outcome = await transactRetrying({
      storage,
      concurrencyRetries,
      work: async (transaction) => {
        const checked = await check(transaction);
        if (checked !== "go") return checked;
        const outcome = await forgetWithin({
          transaction,
          ids,
          clock,
          personId,
          intention,
          context: { correlationId, causationId: correlationId, depth: 0 },
          categories,
          scope,
          batchSize,
        });
        if (outcome === STALE_INTENTION) return "undone";
        if ("held" in outcome) return "skipped";
        // Recorded here as the subscriber will record it, so the row leaves the idle list, its
        // hold with it, before any pass can take the person again; the subscriber's record of
        // the same event then changes nothing.
        if (whole) {
          await transaction.persons.record(forgettingOf({ ...outcome.event, person: personId }));
        }
        return outcome;
      },
    });
    if (typeof outcome === "string") return outcome;
    logForgotten(logger, outcome);
    onForgotten?.(personId);
    return "forgotten";
  };

  const persons = (retention: Retention): Sweepable<StoredPerson> => ({
    activeBefore: (at) => new Date(retentionStart(at, retention)),
    deadlineOf: ({ lastActiveAt }) =>
      lastActiveAt === null ? null : retentionEnd(Date.parse(lastActiveAt), retention),
    list: (args) => storage.persons.listIdle(args),
    count: (activeBefore) =>
      storage.persons.countIdle(activeBefore === undefined ? {} : { activeBefore }),
    nextHoldEnd: (after) => storage.persons.nextHoldEnd(after),
    holdOf: (person) => person.hold,
    forget: (person, through) =>
      forgetting(
        person.person,
        { kind: "whole" },
        async (transaction) => {
          const row = await transaction.persons.get(person.person);
          if (row === null || row.restrictedSince !== null || row.forgottenAt !== null) {
            return "skipped";
          }
          return (await rowIsCurrent(transaction.eventStore, person.person, through, batchSize))
            ? "go"
            : "undone";
        },
        true,
      ),
    hold: (person, hold) => storage.persons.hold(person.person, person.lastActiveAt ?? "", hold),
    describe: (person) => ({ personId: person.person }),
  });

  const keysOf = (category: PersonalCategory & { readonly retention: Retention }) =>
    ({
      activeBefore: (at) => new Date(retentionStart(at, category.retention)),
      deadlineOf: ({ lastActiveAt }) => retentionEnd(Date.parse(lastActiveAt), category.retention),
      list: (args) => storage.personalKeys.listDue({ ...args, category: category.name }),
      count: (activeBefore) =>
        storage.personalKeys.countDue({
          category: category.name,
          ...(activeBefore === undefined ? {} : { activeBefore }),
        }),
      nextHoldEnd: (after) =>
        storage.personalKeys.nextDueHoldEnd({ category: category.name, after }),
      holdOf: (due) => due.hold,
      forget: (due, through) =>
        forgetting(
          due.person,
          { kind: "keys", fingerprints: [due.fingerprint] },
          async (transaction) => {
            const [row, key] = await Promise.all([
              transaction.persons.get(due.person),
              transaction.personalKeys.find(due.person, due.fingerprint),
            ]);
            if ((row?.restrictedSince ?? null) !== null || key?.lastActiveAt !== due.lastActiveAt) {
              return "skipped";
            }
            if (key.retainedSince !== null) return "go";
            return (await rowIsCurrent(transaction.eventStore, due.person, through, batchSize))
              ? "go"
              : "undone";
          },
          false,
        ),
      hold: (due, hold) =>
        storage.personalKeys.holdDue(due.person, due.fingerprint, due.lastActiveAt, hold),
      describe: (due) => ({ personId: due.person, category: due.category }),
    }) satisfies Sweepable<DueKey>;

  // What a forgetting kept that no legal obligation keeps any more, as a category whose basis
  // changed or that the app no longer declares, goes at once.
  const legal = categories.declared
    .filter(({ basis }) => basis === "legal-obligation")
    .map(({ name }) => name);
  const keptBeyond: Sweepable<DueKey> = {
    activeBefore: () => undefined,
    deadlineOf: ({ retainedSince }) => Date.parse(retainedSince ?? ""),
    list: ({ releasedBy, limit }) =>
      storage.personalKeys.listRetained({
        except: legal,
        ...(releasedBy === undefined ? {} : { releasedBy }),
        limit,
      }),
    count: () => storage.personalKeys.countRetained({ except: legal }),
    nextHoldEnd: (after) => storage.personalKeys.nextRetainedHoldEnd({ except: legal, after }),
    holdOf: (due) => due.hold,
    forget: (due) =>
      forgetting(
        due.person,
        { kind: "keys", fingerprints: [due.fingerprint] },
        async (transaction) => {
          const [row, key] = await Promise.all([
            transaction.persons.get(due.person),
            transaction.personalKeys.find(due.person, due.fingerprint),
          ]);
          return (row?.restrictedSince ?? null) !== null ||
            key === null ||
            key.retainedSince === null ||
            legal.includes(key.category)
            ? "skipped"
            : "go";
        },
        false,
      ),
    hold: (due, hold) =>
      storage.personalKeys.holdDue(due.person, due.fingerprint, due.lastActiveAt, hold),
    describe: (due) => ({ personId: due.person, category: due.category }),
  };

  // When the store itself fails a pass, so no record can keep the wait, the sweep stops in this
  // instance for a while.
  const pause = createPause();
  const lease = createLease({
    checkpoints: storage.checkpointStore,
    row: RETENTION_LEASE,
    clock,
    logger,
  });

  // One left undone waits on its own record, so one whose forget keeps failing never holds the
  // others back, every instance skips it, and a host that wakes for `nextDueAt` never wakes for it
  // again at once.
  const hold = async <Due>(
    sweepable: Sweepable<Due>,
    due: Due,
    at: number,
    failed: boolean,
  ): Promise<boolean> => {
    try {
      await sweepable.hold(due, holdAfter({ held: sweepable.holdOf(due), at, failed }));
      return true;
    } catch (error) {
      logger.error("personal data past the retention could not be held", {
        ...sweepable.describe(due),
        error,
      });
      return false;
    }
  };

  // Resolves whether the store kept up: one it could not hold pauses the sweep.
  const attempt = async <Due>(
    sweepable: Sweepable<Due>,
    due: Due,
    at: number,
    through: number,
  ): Promise<{ readonly forgotten: boolean; readonly kept: boolean }> => {
    try {
      const outcome = await sweepable.forget(due, through);
      if (outcome !== "undone") return { forgotten: outcome === "forgotten", kept: true };
      return { forgotten: false, kept: await hold(sweepable, due, at, false) };
    } catch (error) {
      logger.error("personal data past the retention could not be forgotten", {
        ...sweepable.describe(due),
        error,
      });
      return { forgotten: false, kept: await hold(sweepable, due, at, true) };
    }
  };

  const sweepOne = async <Due>(
    sweepable: Sweepable<Due>,
    now: Date,
    through: () => Promise<number>,
  ): Promise<Swept> => {
    const at = now.getTime();
    const activeBefore = sweepable.activeBefore(at);
    const due = await sweepable.list({
      ...(activeBefore === undefined ? {} : { activeBefore }),
      releasedBy: now,
      limit: RETENTION_SWEEP_LIMIT,
    });
    let forgotten = 0;
    let kept = true;
    for (const one of due) {
      // A lease that lapsed while this instance stalled was taken by another, which goes on.
      if (!(await lease.take(clock.now().getTime()))) return { forgotten, kept, lost: true };
      const outcome = await attempt(sweepable, one, at, await through());
      if (outcome.forgotten) forgotten += 1;
      kept &&= outcome.kept;
    }
    return { forgotten, kept, lost: false };
  };

  const runnerOf = <Due>(
    sweepable: Sweepable<Due>,
    category?: PersonalCategory & { readonly retention: Retention },
  ): Runner => ({
    sweep: (now, through) => sweepOne(sweepable, now, through),
    nextDue: (now) => nextDueOf(sweepable, now),
    ...(category === undefined
      ? {}
      : {
          status: async (now: Date) => {
            const [due, [first]] = await Promise.all([
              sweepable.count(sweepable.activeBefore(now.getTime())),
              sweepable.list({ limit: 1 }),
            ]);
            const deadline = first === undefined ? null : sweepable.deadlineOf(first);
            return {
              category: category.name,
              retention: formatRetention(category.retention),
              due,
              nextDueAt: deadline === null ? null : new Date(deadline).toISOString(),
            };
          },
        }),
  });

  // The default category's retention is the app's, which forgets persons as a whole.
  const runners: readonly Runner[] = [
    ...categories.all.flatMap((category) => {
      const { retention } = category;
      if (retention === null) return [];
      return category.basis === null
        ? [runnerOf(persons(retention), { ...category, retention })]
        : [runnerOf(keysOf({ ...category, retention }), { ...category, retention })];
    }),
    runnerOf(keptBeyond),
  ];

  const sweep = async (now: Date): Promise<number> => {
    const at = now.getTime();
    // While another instance holds the lease, its row is one read, the records a batch.
    if (at < lease.heldElsewhereUntil() && !(await lease.take(at))) return 0;
    let checkpoint: Promise<number> | undefined;
    const through = (): Promise<number> => {
      checkpoint ??= storage.checkpointStore.get(RETENTION_SUBSCRIBER);
      return checkpoint;
    };
    let forgotten = 0;
    let kept = true;
    for (const runner of runners) {
      const swept = await runner.sweep(now, through);
      forgotten += swept.forgotten;
      kept &&= swept.kept;
      if (swept.lost) break;
    }
    pause.settle(now.getTime(), kept);
    return forgotten;
  };

  // Nothing comes due before the least recently active one's deadline, so while that one is not
  // held it alone answers. A held one comes due when both its deadline and its hold have passed;
  // the hold's end is named alone, so in the rare case of a retention lengthened since, a host
  // wakes once too early, finds the hold over, and from then on reads the deadline of those free.
  const nextDueOf = async <Due>(sweepable: Sweepable<Due>, now: Date): Promise<number> => {
    const deadlineOf = (due: Due | undefined): number =>
      (due === undefined ? null : sweepable.deadlineOf(due)) ?? Number.POSITIVE_INFINITY;
    const [first] = await sweepable.list({ limit: 1 });
    if (first === undefined || isReleasedBy(sweepable.holdOf(first), now)) {
      return deadlineOf(first);
    }
    const [[free], heldUntil] = await Promise.all([
      sweepable.list({ releasedBy: now, limit: 1 }),
      sweepable.nextHoldEnd(now),
    ]);
    return Math.min(deadlineOf(free), heldUntil?.getTime() ?? Number.POSITIVE_INFINITY);
  };

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at)) return 0;
      try {
        return await sweep(now);
      } catch (error) {
        pause.pause(at);
        logger.error("personal data past the retention could not be listed", { error });
        return 0;
      }
    },
    nextDueAt: async () => {
      const now = clock.now();
      const next = Math.min(...(await Promise.all(runners.map((runner) => runner.nextDue(now)))));
      return next === Number.POSITIVE_INFINITY
        ? null
        : new Date(pause.notBefore(Math.max(next, lease.heldElsewhereUntil())));
    },
    status: async () => {
      const now = clock.now();
      const [statuses, beyond] = await Promise.all([
        Promise.all(runners.flatMap(({ status }) => (status === undefined ? [] : [status(now)]))),
        keptBeyond.count(undefined),
      ]);
      return { categories: statuses, keptBeyond: beyond };
    },
    release: lease.release,
    restored: async (first) => {
      pause.resume();
      lease.reset();
      if (!first) return;
      await Promise.all([
        storage.persons.releaseHolds(),
        storage.personalKeys.releaseDueHolds(),
      ]).catch((error: unknown) => {
        logger.error("the holds of personal data past the retention could not be cleared", {
          error,
        });
      });
    },
  };
};

export interface RetainsFunction {
  (categories: PersonalCategories): boolean;
}

/**
 * Whether anything is forgotten for inactivity: the app's retention is set, or a category is
 * declared, since every declared category has a retention.
 */
export const retains: RetainsFunction = (categories) =>
  categories.all.some(({ retention }) => retention !== null);
