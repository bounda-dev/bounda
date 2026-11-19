import type { PersonStore } from "../../adapter/storage/person-store.ts";
import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../../adapter/storage/subscriber-failure-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { sealedKeys } from "../personal-data/commands.ts";
import { openTextWith, textPersons } from "../personal-data/errors.ts";
import { HELD_RECHECK_MS, stillOpens } from "../personal-data/held-text.ts";
import { createPause } from "../personal-data/hold.ts";
import { restrictedAmong } from "../personal-data/restricted-reads.ts";
import type { PersonalKeys } from "../personal-data/wrapped-keys.ts";
import type { UnreadableRetentionStatus } from "../shared/retention-status.ts";

/**
 * Where the purge of subscriber failures stands: when the earliest failure comes due, `null` when
 * none will without a resolution, and how many past the retention are kept because a person their
 * text is sealed under is restricted and it still opens.
 */
export interface SubscriberFailureRetentionStanding {
  readonly retentionMs: number;
  readonly nextDueAt: string | null;
  readonly held: number;
}

/**
 * The purge of subscriber failures as `app.status()` reports it: where it stands, or that its
 * store could not be read.
 */
export type SubscriberFailureRetentionStatus =
  | SubscriberFailureRetentionStanding
  | UnreadableRetentionStatus;

export interface SubscriberFailureRetention {
  /**
   * Removes every failure past the retention at `now` that no restriction holds, and resolves to
   * how many it removed. Never rejects: a store that fails is logged, and the sweep waits a while
   * before it tries again.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next sweep has a failure to remove, or a held one to read again; `null` when no
   * failure will come due without a resolution. Never rejects: a store that fails is logged, and
   * pauses the sweep, whose end it names.
   */
  nextDueAt(): Promise<Date | null>;
  /**
   * Never rejects: a store that fails is logged, and the purge reported unreadable.
   */
  status(): Promise<SubscriberFailureRetentionStatus>;
  /**
   * After the database went back to a copy: forgets what this instance knew of the purge.
   */
  restored(): void;
}

export interface CreateSubscriberFailureRetentionArgs {
  readonly store: SubscriberFailureStore;
  readonly persons: Pick<PersonStore, "restrictions">;
  readonly keys: PersonalKeys;
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

interface Due {
  readonly failure: StoredSubscriberFailure;
  /**
   * Whose restriction, checked again as it is removed, keeps it: nobody once its text no longer
   * opens.
   */
  readonly holders: readonly string[];
}

interface Standing {
  readonly due: readonly Due[];
  readonly held: number;
  readonly next: number | null;
}

/**
 * A resolved failure comes due a retention after it was resolved; an unresolved one only when its
 * subscriber is not the app's, a retention after it last failed, since a subscriber the app runs
 * is still stuck on it. The store holds one row per subscriber, so a sweep reads them all; it reads
 * again only once the earliest comes due, since a failure resolved after the read comes due a
 * whole retention later. The removal is conditional on the row as read, so instances need no lease.
 *
 * A restriction keeps a failure only while its text still opens: once a key it is sealed under is
 * gone, the person forgotten, as a whole or in any category, or the text sealed for good by a
 * redaction, nothing of theirs is left in it to keep, and a restriction that outlives a forgetting
 * would otherwise keep the row for good.
 */
export const createSubscriberFailureRetention: CreateSubscriberFailureRetentionFunction = ({
  store,
  persons,
  keys,
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
    const open = openTextWith(sealedKeys(keys));
    const due: Due[] = [];
    let held = 0;
    let next = Number.POSITIVE_INFINITY;
    for (const failure of await store.list()) {
      const dueAt = dueAtOf(failure);
      if (dueAt === null) continue;
      if (dueAt > at) {
        next = Math.min(next, dueAt);
        continue;
      }
      const sealedUnder = textPersons(failure);
      const holds = await Promise.all(sealedUnder.map(restricted));
      if (!holds.includes(true)) {
        due.push({ failure, holders: sealedUnder });
      } else if (await stillOpens(open, failure.errorMessage)) {
        held += 1;
      } else {
        due.push({ failure, holders: [] });
      }
    }
    return { due, held, next: next === Number.POSITIVE_INFINITY ? null : next };
  };

  // The next time a sweep reads the store: when the earliest failure comes due, or when a held one
  // is read again.
  const readAgainAt = ({ held, next }: Standing, at: number): number | null => {
    const recheck = held > 0 ? at + HELD_RECHECK_MS : null;
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
        let kept = false;
        for (const { failure, holders } of found.due) {
          if (await store.remove(failure, holders)) purged += 1;
          else kept = true;
        }
        // A failure recorded, resolved or restricted since the read is read again on the next pass.
        unreadUntil = kept
          ? Number.NEGATIVE_INFINITY
          : Math.min(readAgainAt(found, at) ?? Number.POSITIVE_INFINITY, at + retentionMs);
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
      try {
        const found = await standing(at);
        const due = found.due.length > 0 ? at : readAgainAt(found, at);
        return due === null ? null : new Date(pause.notBefore(Math.max(due, unreadUntil)));
      } catch (error) {
        // A host still wakes to try again, once the sweep would.
        pause.pause(at);
        logger.error("subscriber failures past the retention could not be read", { error });
        return new Date(pause.notBefore(at));
      }
    },
    status: async () => {
      const at = clock.now().getTime();
      try {
        const { due, held, next } = await standing(at);
        const dueAt = due.length > 0 ? at : next;
        return {
          retentionMs,
          nextDueAt: dueAt === null ? null : new Date(dueAt).toISOString(),
          held,
        };
      } catch (error) {
        logger.error("subscriber failures past the retention could not be read", { error });
        return { retentionMs, unreadable: true };
      }
    },
    restored: () => {
      unreadUntil = Number.NEGATIVE_INFINITY;
      pause.resume();
    },
  };
};
