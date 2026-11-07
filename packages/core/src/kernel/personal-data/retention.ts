import type { Storage } from "../../adapter/adapter.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { PersonActivity, PersonStore } from "../../adapter/storage/person-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import type { Subscriber } from "../dispatch/delivery.ts";
import { errorDetails } from "../shared/retry.ts";
import { forgetWithin, logForgotten } from "./forget.ts";
import { transactRetrying } from "./transact.ts";

export const RETENTION_SUBSCRIBER: "retention" = "retention";

// How many persons a pass of the worker forgets at most.
export const RETENTION_SWEEP_LIMIT = 50;

// How long a person the sweep left undone waits before the next try, twice as long after each
// failure up to `RETENTION_MAX_RETRY_MS`; and how long a list that could not be read holds it.
export const RETENTION_RETRY_MS = 30_000;

export const RETENTION_MAX_RETRY_MS = 3_600_000;

interface Hold {
  readonly until: number;
  readonly failures: number;
}

const isActivity = (event: StoredEvent): boolean => event.aggregateType !== BOUNDA_AGGREGATE;

// Asked only of the runtime's own events, once `isActivity` said no.
const isForget = (event: StoredEvent): boolean => event.type === PERSONAL_DATA_FORGOTTEN_EVENT;

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
        recorded.set(person, {
          ...known,
          person,
          position: event.position,
          forgottenAt: event.timestamp,
        });
      }
    }
    for (const activity of recorded.values()) await persons.record(activity);
    return events.length;
  },
});

export interface RetentionSweep {
  /**
   * Forgets, as `forget` does with `reason: "retention"`, up to `RETENTION_SWEEP_LIMIT` persons
   * idle past the retention at `now`, and resolves to how many it forgot. Never rejects: what
   * fails is logged and tried again later, a person on their own.
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

  // Resolves `undone` for a person whose row is behind, who is then left for a later pass.
  const forget = async (
    personId: string,
    through: number,
  ): Promise<"forgotten" | "restricted" | "undone"> => {
    const correlationId = ids.next();
    const forgotten = await transactRetrying({
      storage,
      concurrencyRetries,
      work: async (transaction) => {
        const row = await transaction.persons.get(personId);
        if ((row?.restrictedSince ?? null) !== null) return "restricted";
        if (!(await rowIsCurrent(transaction.eventStore, personId, through))) return "undone";
        return forgetWithin({
          transaction,
          ids,
          clock,
          personId,
          reason: "retention",
          context: { correlationId, causationId: correlationId, depth: 0 },
        });
      },
    });
    if (typeof forgotten === "string") return forgotten;
    logForgotten(logger, forgotten);
    return "forgotten";
  };

  // A person left undone waits on their own, so one whose forget keeps failing never holds the
  // others back, and a host that wakes for `nextDueAt` never wakes for them again at once. A list
  // that could not be read holds the whole sweep.
  const holds = new Map<string, Hold>();
  let listHeldUntil = Number.NEGATIVE_INFINITY;

  const hold = (person: string, now: number, failed: boolean): void => {
    const failures = (holds.get(person)?.failures ?? 0) + (failed ? 1 : 0);
    const delay = RETENTION_RETRY_MS * 2 ** Math.max(failures - 1, 0);
    holds.set(person, { until: now + Math.min(delay, RETENTION_MAX_RETRY_MS), failures });
  };

  const sweep = async (now: Date): Promise<number> => {
    const at = now.getTime();
    // Persons held take no place in the batch.
    const idle = await storage.persons.listIdle({
      activeBefore: new Date(at - retentionMs),
      limit: RETENTION_SWEEP_LIMIT + holds.size,
    });
    const listed = new Set(idle.map(({ person }) => person));
    for (const [person, held] of holds) {
      if (held.until <= at && !listed.has(person)) holds.delete(person);
    }
    const due = idle
      .filter(({ person }) => (holds.get(person)?.until ?? at) <= at)
      .slice(0, RETENTION_SWEEP_LIMIT);
    if (due.length === 0) return 0;
    const through = await storage.checkpointStore.get(RETENTION_SUBSCRIBER);
    let forgotten = 0;
    for (const { person } of due) {
      try {
        const outcome = await forget(person, through);
        if (outcome === "undone") {
          hold(person, at, false);
          continue;
        }
        holds.delete(person);
        if (outcome === "forgotten") forgotten += 1;
      } catch (error) {
        hold(person, at, true);
        logger.error("person past the retention could not be forgotten", {
          personId: person,
          ...errorDetails(error),
        });
      }
    }
    return forgotten;
  };

  return {
    sweep: async (now) => {
      if (now.getTime() < listHeldUntil) return 0;
      try {
        return await sweep(now);
      } catch (error) {
        listHeldUntil = now.getTime() + RETENTION_RETRY_MS;
        logger.error("persons past the retention could not be listed", errorDetails(error));
        return 0;
      }
    },
    nextDueAt: async () => {
      const idle = await storage.persons.listIdle({ limit: 1 + holds.size });
      let next = Number.POSITIVE_INFINITY;
      // Least recently active first: past the first person not held, nobody comes due sooner.
      for (const { person, lastActiveAt } of idle) {
        if (lastActiveAt === null) continue;
        const held = holds.get(person)?.until;
        const deadline = Date.parse(lastActiveAt) + retentionMs;
        next = Math.min(next, Math.max(deadline, held ?? deadline));
        if (held === undefined) break;
      }
      return next === Number.POSITIVE_INFINITY ? null : new Date(Math.max(next, listHeldUntil));
    },
  };
};
