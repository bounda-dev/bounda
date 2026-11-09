import type { Storage } from "../../adapter/adapter.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { Hold } from "../../adapter/storage/hold.ts";
import { isReleasedBy } from "../../adapter/storage/hold.ts";
import type {
  PersonActivity,
  PersonStore,
  StoredPerson,
} from "../../adapter/storage/person-store.ts";
import type { DueKey, PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
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
import { isActivity } from "./activity.ts";
import type { PersonalCategories, PersonalCategory } from "./categories.ts";
import { type ForgetScope, forgetWithin, logForgotten } from "./forget.ts";
import { createPause, holdAfter } from "./hold.ts";
import { transactRetrying } from "./transact.ts";

export const RETENTION_SUBSCRIBER: "retention" = "retention";

// How many persons, and how many keys of each category, a pass of the worker forgets at most.
export const RETENTION_SWEEP_LIMIT = 50;

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
   * retention at `now` and not held, as a whole, and as many keys of each declared category idle
   * past that category's retention, and resolves to how many forgettings it made. Never rejects:
   * a person or a key it could not forget is logged and held, longer after each failure.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next person or key the retention may forget becomes due, a held one not before its
   * hold ends; `null` when there is none.
   */
  nextDueAt(): Promise<Date | null>;
}

export interface CreateRetentionSweepArgs {
  readonly storage: Storage;
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

// What a list of things to forget is read through: persons idle past the app's retention, or the
// keys of one category idle past its own.
interface Sweepable<Due> {
  readonly retention: Retention;
  list(args: {
    readonly activeBefore?: Date;
    readonly releasedBy?: Date;
    readonly limit: number;
  }): Promise<readonly Due[]>;
  nextHoldEnd(after: Date): Promise<Date | null>;
  lastActiveAt(due: Due): string | null;
  holdOf(due: Due): Hold | null;
  // Resolves `undone` for one whose record is behind, left for a later pass, and `skipped` for
  // one restricted, or forgotten by another instance, since the list was read.
  forget(due: Due, through: number): Promise<Outcome>;
  hold(due: Due, hold: Hold): Promise<void>;
  // For the log.
  describe(due: Due): Readonly<Record<string, unknown>>;
}

interface Runner {
  sweep(
    now: Date,
    through: () => Promise<number>,
  ): Promise<{ readonly forgotten: number; readonly kept: boolean }>;
  nextDue(now: Date): Promise<number>;
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
  categories,
  ids,
  clock,
  logger,
  concurrencyRetries,
  batchSize,
  forgotten: onForgotten,
}) => {
  const recordIsCurrent = async (
    eventStore: EventStore,
    person: string,
    through: number,
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

  const forgetting = async (
    personId: string,
    scope: ForgetScope,
    check: (
      transaction: Parameters<Parameters<Storage["transact"]>[0]>[0],
    ) => Promise<"go" | Exclude<Outcome, "forgotten">>,
    whole: boolean,
  ): Promise<Outcome> => {
    const correlationId = ids.next();
    const outcome = await transactRetrying({
      storage,
      concurrencyRetries,
      work: async (transaction) => {
        const checked = await check(transaction);
        if (checked !== "go") return checked;
        const forgotten = await forgetWithin({
          transaction,
          ids,
          clock,
          personId,
          reason: "retention",
          context: { correlationId, causationId: correlationId, depth: 0 },
          categories,
          scope,
          batchSize,
        });
        // Recorded here as the subscriber will record it, so the row leaves the idle list, its
        // hold with it, before any pass can take the person again; the subscriber's record of
        // the same event then changes nothing.
        if (whole) {
          await transaction.persons.record(forgettingOf({ ...forgotten.event, person: personId }));
        }
        return forgotten;
      },
    });
    if (typeof outcome === "string") return outcome;
    logForgotten(logger, outcome);
    onForgotten?.(personId);
    return "forgotten";
  };

  const persons = (retention: Retention): Sweepable<StoredPerson> => ({
    retention,
    list: (args) => storage.persons.listIdle(args),
    nextHoldEnd: (after) => storage.persons.nextHoldEnd(after),
    lastActiveAt: (person) => person.lastActiveAt,
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
          return (await recordIsCurrent(transaction.eventStore, person.person, through))
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
      retention: category.retention,
      list: (args) => storage.personalKeys.listDue({ ...args, category: category.name }),
      nextHoldEnd: (after) =>
        storage.personalKeys.nextDueHoldEnd({ category: category.name, after }),
      lastActiveAt: (due) => due.lastActiveAt,
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
            return (await recordIsCurrent(transaction.eventStore, due.person, through))
              ? "go"
              : "undone";
          },
          false,
        ),
      hold: (due, hold) =>
        storage.personalKeys.holdDue(due.person, due.fingerprint, due.lastActiveAt, hold),
      describe: (due) => ({ personId: due.person, category: due.category }),
    }) satisfies Sweepable<DueKey>;

  // When the store itself fails a pass, so no record can keep the wait, the sweep stops in this
  // instance for a while.
  const pause = createPause();

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
  ): Promise<{ readonly forgotten: number; readonly kept: boolean }> => {
    const at = now.getTime();
    const due = await sweepable.list({
      activeBefore: new Date(retentionStart(at, sweepable.retention)),
      releasedBy: now,
      limit: RETENTION_SWEEP_LIMIT,
    });
    let forgotten = 0;
    let kept = true;
    for (const one of due) {
      const outcome = await attempt(sweepable, one, at, await through());
      if (outcome.forgotten) forgotten += 1;
      kept &&= outcome.kept;
    }
    return { forgotten, kept };
  };

  const runnerOf = <Due>(sweepable: Sweepable<Due>): Runner => ({
    sweep: (now, through) => sweepOne(sweepable, now, through),
    nextDue: (now) => nextDueOf(sweepable, now),
  });

  // The default category's retention is the app's, which forgets persons as a whole.
  const runners: readonly Runner[] = categories.all.flatMap((category) => {
    const { retention } = category;
    if (retention === null) return [];
    return category.basis === null
      ? [runnerOf(persons(retention))]
      : [runnerOf(keysOf({ ...category, retention }))];
  });

  const sweep = async (now: Date): Promise<number> => {
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
    }
    pause.settle(now.getTime(), kept);
    return forgotten;
  };

  // Nothing comes due before the least recently active one's deadline, so while that one is not
  // held it alone answers. A held one comes due when both its deadline and its hold have passed;
  // the hold's end is named alone, so in the rare case of a retention lengthened since, a host
  // wakes once too early, finds the hold over, and from then on reads the deadline of those free.
  const nextDueOf = async <Due>(sweepable: Sweepable<Due>, now: Date): Promise<number> => {
    const deadlineOf = (due: Due | undefined): number => {
      const lastActiveAt = due === undefined ? null : sweepable.lastActiveAt(due);
      return lastActiveAt === null
        ? Number.POSITIVE_INFINITY
        : retentionEnd(Date.parse(lastActiveAt), sweepable.retention);
    };
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
      return next === Number.POSITIVE_INFINITY ? null : new Date(pause.notBefore(next));
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
