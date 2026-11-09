import type { Storage } from "../../adapter/adapter.ts";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
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
import { createLease } from "../shared/lease.ts";
import { forgetWithin, logForgotten, STALE_INTENTION } from "./forget.ts";
import { createPause, holdAfter } from "./hold.ts";
import type { ForgetIntentions } from "./intention.ts";
import type { RetentionDueFunction } from "./reconciliation.ts";
import { transactRetrying } from "./transact.ts";

export const RETENTION_SUBSCRIBER: "retention" = "retention";

// How many persons a pass of the worker forgets at most.
export const RETENTION_SWEEP_LIMIT = 50;

/**
 * The checkpoint row of the lease the sweep runs under: one instance forgets at a time.
 */
export const RETENTION_LEASE = "personal-data:retention:lease";

/**
 * Where the retention stands: how many persons are idle past it now, held ones included, and when
 * the next one comes due.
 */
export interface RetentionStatus {
  readonly retentionMs: number;
  readonly due: number;
  readonly nextDueAt: string | null;
}

const isActivity = (event: StoredEvent): boolean => event.aggregateType !== BOUNDA_AGGREGATE;

// Asked only of the runtime's own events, once `isActivity` said no.
const isForget = (event: StoredEvent): boolean => event.type === PERSONAL_DATA_FORGOTTEN_EVENT;

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
  readonly retentionMs: number;
  readonly batchSize: number;
  /**
   * Where the retention subscriber keeps how far its rows reach.
   */
  readonly checkpoints: CheckpointStore;
}

export interface RetentionDueOfFunction {
  (args: RetentionDueArgs): RetentionDueFunction;
}

/**
 * Whether the retention would forget the person at `now`, as a sweep decides it in the transaction
 * that forgets them.
 */
export const retentionDueOf: RetentionDueOfFunction =
  ({ retentionMs, batchSize, checkpoints }) =>
  async (stores, personId, now) => {
    const row = await stores.persons.get(personId);
    if (!isIdle(row) || row.lastActiveAt === null) return false;
    if (Date.parse(row.lastActiveAt) + retentionMs > now.getTime()) return false;
    const through = await checkpoints.get(RETENTION_SUBSCRIBER);
    return rowIsCurrent(stores.eventStore, personId, through, batchSize);
  };

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
  intentions,
  retentionMs,
  ids,
  clock,
  logger,
  concurrencyRetries,
  batchSize,
  forgotten: onForgotten,
}) => {
  // Resolves `undone` for a person whose row is behind, or who was given a key since the
  // intention, who is then left for a later pass, and `skipped` for one restricted, or forgotten by
  // another instance, since the list was read. Both are decided once before the intention, so a
  // person plainly left leaves none, and again in the transaction; an intention it then leaves is
  // committed again only if the retention would still forget the person.
  const forget = async (
    personId: string,
    through: number,
  ): Promise<"forgotten" | "skipped" | "undone"> => {
    if (!isIdle(await storage.persons.get(personId))) return "skipped";
    if (!(await rowIsCurrent(storage.eventStore, personId, through, batchSize))) return "undone";
    const intention = await intentions.intend({
      personId,
      reason: "retention",
      keys: storage.personalKeys,
    });
    const correlationId = ids.next();
    const forgotten = await transactRetrying({
      storage,
      concurrencyRetries,
      work: async (transaction) => {
        if (!isIdle(await transaction.persons.get(personId))) return "skipped";
        if (!(await rowIsCurrent(transaction.eventStore, personId, through, batchSize))) {
          return "undone";
        }
        const outcome = await forgetWithin({
          transaction,
          ids,
          clock,
          personId,
          intention,
          context: { correlationId, causationId: correlationId, depth: 0 },
        });
        if (outcome === STALE_INTENTION) return "undone";
        if ("held" in outcome) return "skipped";
        // Recorded here as the subscriber will record it, so the row leaves the idle list, its
        // hold with it, before any pass can take the person again; the subscriber's record of the
        // same event then changes nothing.
        await transaction.persons.record(forgettingOf({ ...outcome.event, person: personId }));
        return outcome;
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
  const lease = createLease({
    checkpoints: storage.checkpointStore,
    row: RETENTION_LEASE,
    clock,
    logger,
  });

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
        error,
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
        error,
      });
      return { forgotten: false, kept: await hold(person, at, true) };
    }
  };

  const sweep = async (now: Date): Promise<number> => {
    const at = now.getTime();
    // While another instance holds the lease, its row is one read, the persons a batch.
    if (at < lease.heldElsewhereUntil() && !(await lease.take(at))) return 0;
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
      // A lease that lapsed while this instance stalled was taken by another, which goes on.
      if (!(await lease.take(clock.now().getTime()))) break;
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
        logger.error("persons past the retention could not be listed", { error });
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
      return next === Number.POSITIVE_INFINITY
        ? null
        : new Date(pause.notBefore(Math.max(next, lease.heldElsewhereUntil())));
    },
    status: async () => {
      const now = clock.now();
      const [due, next] = await Promise.all([
        storage.persons.countIdle({ activeBefore: new Date(now.getTime() - retentionMs) }),
        storage.persons.listIdle({ limit: 1 }),
      ]);
      const deadline = deadlineOf(next[0]);
      return {
        retentionMs,
        due,
        nextDueAt: deadline === Number.POSITIVE_INFINITY ? null : new Date(deadline).toISOString(),
      };
    },
    release: lease.release,
    restored: async (first) => {
      pause.resume();
      lease.reset();
      if (!first) return;
      await storage.persons.releaseHolds().catch((error: unknown) => {
        logger.error("the holds of persons past the retention could not be cleared", { error });
      });
    },
  };
};
