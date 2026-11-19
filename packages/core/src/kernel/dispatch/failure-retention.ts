import type { PersonStore } from "../../adapter/storage/person-store.ts";
import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../../adapter/storage/subscriber-failure-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { textPersons } from "../personal-data/errors.ts";
import { createPause } from "../personal-data/hold.ts";
import { restrictedAmong } from "../personal-data/restricted-reads.ts";

// How long a failure past the retention that a restriction holds waits before it is read again:
// a restriction lifted in another instance tells nobody here.
export const HELD_FAILURE_RECHECK_MS = 3_600_000;

/**
 * Where the purge of subscriber failures stands: when the earliest failure comes due, `null` when
 * none will without a resolution, and how many past the retention are kept because a person their
 * text is sealed under is restricted.
 */
export interface SubscriberFailureRetentionStatus {
  readonly retentionMs: number;
  readonly nextDueAt: string | null;
  readonly held: number;
}

export interface SubscriberFailureRetention {
  /**
   * Removes every failure past the retention at `now` that no restriction holds, and resolves to
   * how many it removed. Never rejects: a store that fails is logged, and the sweep waits a while
   * before it tries again.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next sweep has a failure to remove, or a held one to read again; `null` when no
   * failure will come due without a resolution.
   */
  nextDueAt(): Promise<Date | null>;
  status(): Promise<SubscriberFailureRetentionStatus>;
  /**
   * After the database went back to a copy: forgets what this instance knew of the purge.
   */
  restored(): void;
}

export interface CreateSubscriberFailureRetentionArgs {
  readonly store: SubscriberFailureStore;
  readonly persons: Pick<PersonStore, "restrictions">;
  /**
   * The subscribers the app runs: the failure of any other is past once it failed a retention ago,
   * since nothing will get past it.
   */
  readonly subscribers: readonly string[];
  readonly retentionMs: number;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateSubscriberFailureRetentionFunction {
  (args: CreateSubscriberFailureRetentionArgs): SubscriberFailureRetention;
}

interface Standing {
  readonly due: readonly StoredSubscriberFailure[];
  readonly held: number;
  readonly next: number | null;
}

/**
 * A resolved failure comes due a retention after it was resolved; an unresolved one only when its
 * subscriber is not the app's, a retention after it last failed, since a subscriber the app runs
 * is still stuck on it. The store holds one row per subscriber, so a sweep reads them all; it reads
 * again only once the earliest comes due, since a failure resolved after the read comes due a
 * whole retention later. The removal is conditional on the row as read, so instances need no lease.
 */
export const createSubscriberFailureRetention: CreateSubscriberFailureRetentionFunction = ({
  store,
  persons,
  subscribers,
  retentionMs,
  clock,
  logger,
}) => {
  const running = new Set(subscribers);
  const pause = createPause();
  let unreadUntil = Number.NEGATIVE_INFINITY;

  const dueAtOf = ({ subscriber, resolvedAt, lastFailedAt }: StoredSubscriberFailure) => {
    if (resolvedAt !== null) return Date.parse(resolvedAt) + retentionMs;
    return running.has(subscriber) ? null : Date.parse(lastFailedAt) + retentionMs;
  };

  const standing = async (at: number): Promise<Standing> => {
    const restricted = restrictedAmong(persons);
    const due: StoredSubscriberFailure[] = [];
    let held = 0;
    let next = Number.POSITIVE_INFINITY;
    for (const failure of await store.list()) {
      const dueAt = dueAtOf(failure);
      if (dueAt === null) continue;
      if (dueAt > at) {
        next = Math.min(next, dueAt);
        continue;
      }
      const holds = await Promise.all(textPersons(failure).map(restricted));
      if (holds.includes(true)) held += 1;
      else due.push(failure);
    }
    return { due, held, next: next === Number.POSITIVE_INFINITY ? null : next };
  };

  // The next time a sweep reads the store: when the earliest failure comes due, or when a held one
  // is read again.
  const readAgainAt = ({ held, next }: Standing, at: number): number | null => {
    const recheck = held > 0 ? at + HELD_FAILURE_RECHECK_MS : null;
    if (next === null) return recheck;
    return recheck === null ? next : Math.min(next, recheck);
  };

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at) || at < unreadUntil) return 0;
      try {
        const found = await standing(at);
        let purged = 0;
        for (const failure of found.due) {
          if (await store.remove(failure)) purged += 1;
        }
        unreadUntil = Math.min(
          readAgainAt(found, at) ?? Number.POSITIVE_INFINITY,
          at + retentionMs,
        );
        pause.resume();
        if (purged > 0) logger.debug("subscriber failures past the retention purged", { purged });
        return purged;
      } catch (error) {
        pause.pause(at);
        logger.error("subscriber failures past the retention could not be purged", { error });
        return 0;
      }
    },
    nextDueAt: async () => {
      const at = clock.now().getTime();
      const found = await standing(at);
      const due = found.due.length > 0 ? at : readAgainAt(found, at);
      return due === null ? null : new Date(pause.notBefore(Math.max(due, unreadUntil)));
    },
    status: async () => {
      const at = clock.now().getTime();
      const { due, held, next } = await standing(at);
      const dueAt = due.length > 0 ? at : next;
      return {
        retentionMs,
        nextDueAt: dueAt === null ? null : new Date(dueAt).toISOString(),
        held,
      };
    },
    restored: () => {
      unreadUntil = Number.NEGATIVE_INFINITY;
      pause.resume();
    },
  };
};
