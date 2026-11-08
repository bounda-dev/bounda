import type { Storage } from "../../adapter/adapter.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import { isReleasedBy } from "../../adapter/storage/hold.ts";
import type {
  PersonActivity,
  PersonStore,
  StoredPerson,
} from "../../adapter/storage/person-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import type { Subscriber } from "../dispatch/delivery.ts";
import { errorDetails } from "../shared/retry.ts";
import { forgetWithin, logForgotten } from "./forget.ts";
import { createPause, holdAfter } from "./hold.ts";
import { transactRetrying } from "./transact.ts";

export const RETENTION_SUBSCRIBER: "retention" = "retention";

// How many persons a pass of the worker forgets at most.
export const RETENTION_SWEEP_LIMIT = 50;

const isActivity = (event: StoredEvent): boolean => event.aggregateType !== BOUNDA_AGGREGATE;

// Asked only of the runtime's own events, once `isActivity` said no.
const isForget = (event: StoredEvent): boolean => event.type === PERSONAL_DATA_FORGOTTEN_EVENT;

// What a `PersonalDataForgotten` says of its person; their last activity stays as it was.
const forgettingOf = (event: StoredEvent & { readonly person: string }): PersonActivity => ({
  person: event.person,
  position: event.position,
  forgottenAt: event.timestamp,
});

export interface CreateRetentionSubscriberArgs {
  readonly persons: PersonStore;
}

export interface CreateRetentionSubscriberFunction {
  (args: CreateRetentionSubscriberArgs): Subscriber;
}

/**
 * Follows the global stream from its first event and records, per person an event names, their
 * last activity, an event of the app's aggregates, and their last forgetting, which activity
 * after it clears; the runtime's other events on `bounda:<personId>` change nothing. One write per
 * person and batch, which the store ignores for a batch it recorded already, so a batch delivered
 * twice, or from the start again, leaves the same rows.
 */
export const createRetentionSubscriber: CreateRetentionSubscriberFunction = ({ persons }) => ({
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
      } else if (isForget(event)) {
        recorded.set(person, { ...known, ...forgettingOf({ ...event, person }) });
      }
    }
    for (const activity of recorded.values()) await persons.record(activity);
    return events.length;
  },
});

export interface RetentionSweep {
  /**
   * Forgets, as `forget` does with `reason: "retention"`, up to `RETENTION_SWEEP_LIMIT` persons
   * idle past the retention at `now` and not held, and resolves to how many it forgot. Never
   * rejects: a person it could not forget is logged and held on their row, longer after each
   * failure.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next person the retention may forget becomes due, a held one not before their hold
   * ends; `null` when there is none.
   */
  nextDueAt(): Promise<Date | null>;
}

export interface CreateRetentionSweepArgs {
  readonly storage: Storage;
  readonly retentionMs: number;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  readonly batchSize: number;
  /**
   * Called with each person forgotten, once their forgetting is committed.
   */
  readonly forgotten?: (personId: string) => void;
}

export interface CreateRetentionSweepFunction {
  (args: CreateRetentionSweepArgs): RetentionSweep;
}

/**
 * The rows lag behind the stream by what the subscriber has not recorded yet, so a person is
 * forgotten only when no event past its checkpoint names them as active or forgotten already,
 * read in the transaction that forgets them, with their restriction: a person active a moment
 * ago is not forgotten for an activity the row does not show yet, and of two instances sweeping
 * one person, the one whose append conflicts reads the other's forgetting on its retry and stops.
 * `storage` is the store as written: the sweep reads no personal field.
 */
export const createRetentionSweep: CreateRetentionSweepFunction = ({
  storage,
  retentionMs,
  ids,
  clock,
  logger,
  concurrencyRetries,
  batchSize,
  forgotten: onForgotten,
}) => {
  const rowIsCurrent = async (
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

  // Resolves `undone` for a person whose row is behind, who is then left for a later pass, and
  // `skipped` for one restricted, or forgotten by another instance, since the list was read.
  const forget = async (
    personId: string,
    through: number,
  ): Promise<"forgotten" | "skipped" | "undone"> => {
    const correlationId = ids.next();
    const forgotten = await transactRetrying({
      storage,
      concurrencyRetries,
      work: async (transaction) => {
        const row = await transaction.persons.get(personId);
        if (row === null || row.restrictedSince !== null || row.forgottenAt !== null) {
          return "skipped";
        }
        if (!(await rowIsCurrent(transaction.eventStore, personId, through))) return "undone";
        const forgotten = await forgetWithin({
          transaction,
          ids,
          clock,
          personId,
          reason: "retention",
          context: { correlationId, causationId: correlationId, depth: 0 },
        });
        // Recorded here as the subscriber will record it, so the row leaves the idle list, its
        // hold with it, before any pass can take the person again; the subscriber's record of the
        // same event then changes nothing.
        await transaction.persons.record(forgettingOf({ ...forgotten.event, person: personId }));
        return forgotten;
      },
    });
    if (typeof forgotten === "string") return forgotten;
    logForgotten(logger, forgotten);
    onForgotten?.(personId);
    return "forgotten";
  };

  // When the store itself fails a pass, so no row can keep the wait, the sweep stops in this
  // instance for a while.
  const pause = createPause();

  // A person left undone waits on their own row, so one whose forget keeps failing never holds
  // the others back, every instance skips them, and a host that wakes for `nextDueAt` never wakes
  // for them again at once.
  const hold = async (person: StoredPerson, at: number, failed: boolean): Promise<boolean> => {
    try {
      await storage.persons.hold(
        person.person,
        person.lastActiveAt ?? "",
        holdAfter({ held: person.hold, at, failed }),
      );
      return true;
    } catch (error) {
      logger.error("person past the retention could not be held", {
        personId: person.person,
        ...errorDetails(error),
      });
      return false;
    }
  };

  // Resolves whether the store kept up: a person it could not hold pauses the sweep.
  const attempt = async (
    person: StoredPerson,
    at: number,
    through: number,
  ): Promise<{ readonly forgotten: boolean; readonly kept: boolean }> => {
    try {
      const outcome = await forget(person.person, through);
      if (outcome !== "undone") return { forgotten: outcome === "forgotten", kept: true };
      return { forgotten: false, kept: await hold(person, at, false) };
    } catch (error) {
      logger.error("person past the retention could not be forgotten", {
        personId: person.person,
        ...errorDetails(error),
      });
      return { forgotten: false, kept: await hold(person, at, true) };
    }
  };

  const sweep = async (now: Date): Promise<number> => {
    const at = now.getTime();
    const due = await storage.persons.listIdle({
      activeBefore: new Date(at - retentionMs),
      releasedBy: now,
      limit: RETENTION_SWEEP_LIMIT,
    });
    if (due.length === 0) {
      pause.resume();
      return 0;
    }
    const through = await storage.checkpointStore.get(RETENTION_SUBSCRIBER);
    let forgotten = 0;
    let kept = true;
    for (const person of due) {
      const outcome = await attempt(person, at, through);
      if (outcome.forgotten) forgotten += 1;
      kept &&= outcome.kept;
    }
    pause.settle(at, kept);
    return forgotten;
  };

  const deadlineOf = (person: StoredPerson | undefined): number =>
    typeof person?.lastActiveAt === "string"
      ? Date.parse(person.lastActiveAt) + retentionMs
      : Number.POSITIVE_INFINITY;

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at)) return 0;
      try {
        return await sweep(now);
      } catch (error) {
        pause.pause(at);
        logger.error("persons past the retention could not be listed", errorDetails(error));
        return 0;
      }
    },
    // Nobody comes due before the least recently active person's deadline, so while that person
    // is not held it alone answers. A held person comes due when both their deadline and their
    // hold have passed; the hold's end is named alone, so in the rare case of a retention
    // lengthened since, a host wakes once too early, finds their hold over, and from then on reads
    // their deadline with the persons free.
    nextDueAt: async () => {
      const now = clock.now();
      const [first] = await storage.persons.listIdle({ limit: 1 });
      let next = deadlineOf(first);
      if (first !== undefined && !isReleasedBy(first.hold, now)) {
        const [[free], heldUntil] = await Promise.all([
          storage.persons.listIdle({ releasedBy: now, limit: 1 }),
          storage.persons.nextHoldEnd(now),
        ]);
        next = Math.min(deadlineOf(free), heldUntil?.getTime() ?? Number.POSITIVE_INFINITY);
      }
      return next === Number.POSITIVE_INFINITY ? null : new Date(pause.notBefore(next));
    },
  };
};
