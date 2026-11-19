import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { DeadLetterStore, StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { PersonStore } from "../../adapter/storage/person-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { sealedKeys } from "../personal-data/commands.ts";
import { openTextWith, textPersons } from "../personal-data/errors.ts";
import { HELD_RECHECK_MS, stillOpens } from "../personal-data/held-text.ts";
import { createPause } from "../personal-data/hold.ts";
import { restrictedAmong } from "../personal-data/restricted-reads.ts";
import type { PersonalKeys } from "../personal-data/wrapped-keys.ts";
import { createLease } from "../shared/lease.ts";

// How many resolved letters a pass of the worker removes, or reads among those a restriction
// holds, at most.
export const DEAD_LETTER_PURGE_LIMIT = 100;

/**
 * The checkpoint row of the lease the purge runs under: one instance purges at a time.
 */
export const DEAD_LETTER_PURGE_LEASE = "dead-letters:purge:lease";

/**
 * Where the purge stands: when the earliest resolved letter comes due, `null` when none will
 * without a resolution, and how many past the retention are kept because a person they hold data
 * of is restricted and it still opens.
 */
export interface DeadLetterRetentionStatus {
  readonly retentionMs: number;
  readonly nextDueAt: string | null;
  readonly held: number;
}

export interface DeadLetterRetention {
  /**
   * Removes up to `DEAD_LETTER_PURGE_LIMIT` letters resolved longer than the retention ago at
   * `now` that no restriction holds, and resolves to how many it removed. Never rejects: a store
   * that fails is logged, and the sweep waits a while before it tries again.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next sweep has a letter to remove, or a held one to read again; `null` when no
   * letter will come due without a resolution. Never rejects: a store that fails is logged, and
   * pauses the sweep, whose end it names.
   */
  nextDueAt(): Promise<Date | null>;
  status(): Promise<DeadLetterRetentionStatus>;
  /**
   * Gives the lease back when this instance holds it. Never rejects.
   */
  release(): Promise<void>;
  /**
   * After the database went back to a copy: forgets what this instance knew of the purge.
   */
  restored(): void;
}

export interface CreateDeadLetterRetentionArgs {
  readonly store: DeadLetterStore;
  readonly checkpoints: CheckpointStore;
  readonly persons: Pick<PersonStore, "restrictions">;
  readonly keys: PersonalKeys;
  readonly retentionMs: number;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateDeadLetterRetentionFunction {
  (args: CreateDeadLetterRetentionArgs): DeadLetterRetention;
}

interface Hold {
  /**
   * Whose restriction, checked again as the letter is removed, keeps it: everyone whose data in
   * it still opens.
   */
  readonly holders: readonly string[];
  readonly holds: boolean;
}

interface Due {
  readonly resolved: number | null;
  readonly held: number | null;
}

const earliest = (...times: readonly (number | null)[]): number | null =>
  times.reduce<number | null>(
    (first, time) => (time === null || (first !== null && first <= time) ? first : time),
    null,
  );

/**
 * Asks the store first when the earliest resolved letter is due, a read an index answers, so a
 * pass with nothing due writes nothing; and asks again only once that time comes, since a letter
 * resolved after the read comes due a whole retention later.
 *
 * The store leaves every letter that names a person with a restriction, checked as it removes.
 * Those past the retention are read here, a page a pass, once they come due and again every
 * `HELD_RECHECK_MS`, since a restriction lifted in another instance tells nobody here: a
 * restriction keeps a letter only while what it holds of the person still opens. The fields a
 * scheduled command sealed open for as long as the letter names them, since a forget removes the
 * letter with the keys they are sealed under but those it keeps; the error text opens until a key
 * it is sealed under is gone, the person forgotten, as a whole or in any category, or the text
 * sealed for good by a redaction, and a restriction that outlives a forgetting would otherwise
 * keep the letter for good.
 */
export const createDeadLetterRetention: CreateDeadLetterRetentionFunction = ({
  store,
  checkpoints,
  persons,
  keys,
  retentionMs,
  clock,
  logger,
}) => {
  const pause = createPause();
  const lease = createLease({ checkpoints, row: DEAD_LETTER_PURGE_LEASE, clock, logger });
  const dueAt = (resolvedAt: Date | null): number | null =>
    resolvedAt === null ? null : resolvedAt.getTime() + retentionMs;
  let unreadUntil = Number.NEGATIVE_INFINITY;
  // When the held letters are read again, and the `id` the next page of them starts after.
  let heldReadAt = Number.NEGATIVE_INFINITY;
  let heldAfter: string | undefined;

  const due = async (): Promise<Due> => {
    const [resolved, held] = await Promise.all([store.firstResolvedAt(), store.firstHeldAt()]);
    return { resolved: dueAt(resolved), held: dueAt(held) };
  };

  // When held letters are next read: once the first comes due, then at `heldReadAt`, which a letter
  // that comes due meanwhile waits for too.
  const heldDueAt = ({ held }: Due): number | null =>
    held === null ? null : Math.max(held, heldReadAt);

  const holdOf = async (
    letter: StoredDeadLetter,
    restricted: (person: string) => Promise<boolean>,
    open: (value: StoredDeadLetter["errorMessage"]) => Promise<string | null>,
  ): Promise<Hold> => {
    const sealedUnder = textPersons(letter);
    const restrictedText = (await Promise.all(sealedUnder.map(restricted))).includes(true);
    const holders = [
      ...(letter.persons ?? []).map(({ person }) => person),
      ...(!restrictedText || (await stillOpens(open, letter.errorMessage)) ? sealedUnder : []),
    ];
    return { holders, holds: (await Promise.all(holders.map(restricted))).includes(true) };
  };

  const heldPage = (at: number, after: string | undefined) =>
    store.listHeld({
      resolvedBy: new Date(at - retentionMs),
      after,
      limit: DEAD_LETTER_PURGE_LIMIT,
    });

  // Removes the letters of a page of held ones that no restriction keeps any longer.
  const release = async (at: number): Promise<number> => {
    const restricted = restrictedAmong(persons);
    const open = openTextWith(sealedKeys(keys));
    const page = await heldPage(at, heldAfter);
    let released = 0;
    for (const letter of page) {
      const { holders, holds } = await holdOf(letter, restricted, open);
      if (!holds && (await store.removeHeld(letter, holders))) released += 1;
    }
    // A letter restricted or written again since the read is read again with the others.
    heldAfter = page.length < DEAD_LETTER_PURGE_LIMIT ? undefined : page.at(-1)?.id;
    if (heldAfter === undefined) heldReadAt = at + HELD_RECHECK_MS;
    return released;
  };

  const nextDueAt = async (): Promise<Date | null> => {
    const at = clock.now().getTime();
    try {
      const found = await due();
      const next = earliest(found.resolved, heldDueAt(found));
      return next === null
        ? null
        : new Date(pause.notBefore(Math.max(next, unreadUntil, lease.heldElsewhereUntil())));
    } catch (error) {
      // A host still wakes to try again, once the sweep would.
      pause.pause(at);
      logger.error("resolved dead letters could not be read", { error });
      return new Date(pause.notBefore(at));
    }
  };

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at) || at < unreadUntil) return 0;
      try {
        const found = await due();
        const purging = found.resolved !== null && found.resolved <= at;
        const heldNext = heldDueAt(found);
        const releasing = heldNext !== null && heldNext <= at;
        // A read of the held letters left off, by a pass that found none due, starts over.
        if (!releasing) heldAfter = undefined;
        if (!purging && !releasing) {
          unreadUntil = Math.min(
            found.resolved ?? at + retentionMs,
            heldNext ?? Number.POSITIVE_INFINITY,
          );
          pause.resume();
          return 0;
        }
        if (!(await lease.take(at))) return 0;
        const purged = purging
          ? await store.purge({
              resolvedBy: new Date(at - retentionMs),
              limit: DEAD_LETTER_PURGE_LIMIT,
            })
          : 0;
        const released = releasing ? await release(at) : 0;
        pause.resume();
        if (purged + released > 0) {
          logger.debug("resolved dead letters purged", { purged: purged + released });
        }
        return purged + released;
      } catch (error) {
        pause.pause(at);
        logger.error("resolved dead letters could not be purged", { error });
        return 0;
      }
    },
    nextDueAt,
    status: async () => {
      const at = clock.now().getTime();
      const found = await due();
      let held = 0;
      let releasable = false;
      const restricted = restrictedAmong(persons);
      const open = openTextWith(sealedKeys(keys));
      let after: string | undefined;
      do {
        const page = await heldPage(at, after);
        for (const letter of page) {
          if ((await holdOf(letter, restricted, open)).holds) held += 1;
          else releasable = true;
        }
        after = page.length < DEAD_LETTER_PURGE_LIMIT ? undefined : page.at(-1)?.id;
      } while (after !== undefined);
      const next = earliest(
        found.resolved,
        releasable ? at : null,
        found.held !== null && found.held > at ? found.held : null,
      );
      return { retentionMs, nextDueAt: next === null ? null : new Date(next).toISOString(), held };
    },
    release: lease.release,
    restored: () => {
      unreadUntil = Number.NEGATIVE_INFINITY;
      heldReadAt = Number.NEGATIVE_INFINITY;
      heldAfter = undefined;
      pause.resume();
      lease.reset();
    },
  };
};
