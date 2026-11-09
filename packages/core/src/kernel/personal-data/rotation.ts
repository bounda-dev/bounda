import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { PersonalKeyRow, PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { digest } from "../read-model/fingerprint.ts";
import { createLease } from "../shared/lease.ts";
import { createPause, holdAfter } from "./hold.ts";
import type { CryptoKeyWrapper } from "./key-wrapper.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

// How many keys a pass of the worker rewraps at most.
export const ROTATION_BATCH = 50;

// How long a rotation found complete stands before a pass reads the key table again, across every
// instance: a key an instance still on an older configuration wraps meanwhile, as in a rolling
// deploy, waits this long.
export const ROTATION_CHECK_INTERVAL_MS = 60_000;

/**
 * The checkpoint rows that say the rotation is complete, one per set of wrapping keys, named
 * after the set's digest: each keeps, in milliseconds, when the key table was last found with
 * nothing left to rewrap under that set, so another set of keys reads the table again.
 */
export const ROTATED_PREFIX = "personal-keys:rotated:";

// How old the mark of another set of wrapping keys must be before a rotation completing removes
// it: a set some instance still runs is checked, and its mark renewed, every
// `ROTATION_CHECK_INTERVAL_MS`, so a mark this old is no running instance's.
export const ROTATION_MARK_EXPIRY_MS: number = 10 * ROTATION_CHECK_INTERVAL_MS;

/**
 * The checkpoint rows of the lease each set of wrapping keys rotates under, named after the set's
 * digest as its mark is: one instance rewraps at a time.
 */
export const ROTATION_LEASE_PREFIX = "personal-keys:rotating:";

/**
 * Where the rotation under one set of wrapping keys stands.
 */
export interface KeyRotationStatus {
  readonly kid: string;
  readonly previous: readonly string[];
  /**
   * How many keys are left to rewrap, held ones included.
   */
  readonly pending: number;
  /**
   * When a pass last found none left, `null` while one is.
   */
  readonly completeAt: string | null;
}

export interface KeyRotation {
  /**
   * Rewraps under the wrapper's key up to `ROTATION_BATCH` keys wrapped under a previous one or
   * kept unwrapped, and not held, and resolves to how many it rewrapped. Never rejects: a key that
   * failed is logged and held on its row, longer after each failure.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next pass has a key to rewrap, a held one not before its hold ends; `null` when there
   * is none, and without reading the key table once the rotation is complete.
   */
  nextDueAt(): Promise<Date | null>;
  status(): Promise<KeyRotationStatus>;
  /**
   * Gives the lease back when this instance holds it. Never rejects.
   */
  release(): Promise<void>;
  /**
   * After the database went back to a copy: forgets what this instance knew of the rotation, and,
   * when `first`, clears the holds of the keys the copy brought back. Never rejects.
   */
  restored(first: boolean): Promise<void>;
}

export interface CreateKeyRotationArgs {
  /**
   * The store as written, whose keys are read and written wrapped.
   */
  readonly keys: PersonalKeyStore;
  readonly checkpoints: CheckpointStore;
  readonly wrapper: Pick<CryptoKeyWrapper, "kid" | "previous">;
  readonly wrapping: PersonalKeyWrapping;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateKeyRotationFunction {
  (args: CreateKeyRotationArgs): KeyRotation;
}

const digestOf = (kid: string, previous: readonly string[]): string =>
  digest(JSON.stringify([kid, ...[...new Set(previous)].sort()]));

interface Answer {
  readonly next: number | null;
  readonly until: number;
}

/**
 * Keys wrapped under a previous key, and keys from before a wrapper was configured, are
 * rewrapped under the current one; a key forgotten or replaced while it was being rewrapped is
 * left as the store holds it. Once none is left the rotation marks it complete for this set of
 * wrapping keys and logs it, once until it rewraps again, so an operator knows the previous keys
 * can go. While the mark stands nothing reads the key table, but a pass once every
 * `ROTATION_CHECK_INTERVAL_MS` across instances, which drops the mark when it finds a key again.
 */
export const createKeyRotation: CreateKeyRotationFunction = ({
  keys,
  checkpoints,
  wrapper,
  wrapping,
  clock,
  logger,
}) => {
  // A wrapper that names its own key among the previous ones would rewrap it on every pass.
  const previous = wrapper.previous.filter((kid) => kid !== wrapper.kid);
  const kids = [...previous, null];
  const set = digestOf(wrapper.kid, previous);
  const marker = `${ROTATED_PREFIX}${set}`;
  const lease = createLease({
    checkpoints,
    row: `${ROTATION_LEASE_PREFIX}${set}`,
    clock,
    logger,
  });
  // Until when a pass reads nothing: the mark stands, or every key left is held.
  let completeUntil = Number.NEGATIVE_INFINITY;
  let restUntil = Number.NEGATIVE_INFINITY;
  // What `nextDueAt` last read, so a host that asks after every request reads the store once a
  // check interval at most; a pass that reads the table forgets it.
  let answer: Answer | null = null;
  const pause = createPause();
  let rewrappedAny = false;

  const report = (): void => {
    if (previous.length > 0) {
      logger.info("no personal key is wrapped under a previous key any more; remove them", {
        kid: wrapper.kid,
        previous,
      });
    } else if (rewrappedAny) {
      logger.info("every personal key is wrapped", { kid: wrapper.kid });
    }
  };

  // Of several instances finding it complete at once, the one that marks it first logs it.
  const complete = async (markedAt: number, at: number): Promise<void> => {
    completeUntil = at + ROTATION_CHECK_INTERVAL_MS;
    if (!(await checkpoints.compareAndSet(marker, markedAt, at))) return;
    if (markedAt === 0) report();
    // The lease of another set lapsed at its position, as long ago as its mark was renewed.
    for (const { subscriber, position } of await checkpoints.list()) {
      if (
        (subscriber.startsWith(ROTATED_PREFIX) || subscriber.startsWith(ROTATION_LEASE_PREFIX)) &&
        subscriber !== marker &&
        subscriber !== `${ROTATION_LEASE_PREFIX}${set}` &&
        at - position >= ROTATION_MARK_EXPIRY_MS
      ) {
        await checkpoints.remove(subscriber);
      }
    }
  };

  // Resolves whether the store kept the hold; one it could not keep pauses the rotation.
  const rewrap = async (
    row: PersonalKeyRow,
    at: number,
  ): Promise<{ readonly rewrapped: boolean; readonly kept: boolean }> => {
    try {
      const to = await wrapping.wrapped(row.key);
      return { rewrapped: await keys.rewrap(row.person, row.key, to), kept: true };
    } catch (error) {
      logger.error("personal key could not be rewrapped", {
        personId: row.person,
        kid: row.key.kid,
        error,
      });
    }
    try {
      await keys.hold(row.person, row.key, holdAfter({ held: row.hold, at, failed: true }));
      return { rewrapped: false, kept: true };
    } catch (error) {
      logger.error("personal key could not be held", {
        personId: row.person,
        kid: row.key.kid,
        error,
      });
      return { rewrapped: false, kept: false };
    }
  };

  const sweep = async (now: Date): Promise<number> => {
    const at = now.getTime();
    const markedAt = await checkpoints.get(marker);
    // A set never marked reads 0, as long ago as can be; a mark ahead of this clock, set by an
    // instance whose clock runs ahead, is checked rather than trusted for longer than it says.
    if (markedAt <= at && at - markedAt < ROTATION_CHECK_INTERVAL_MS) {
      completeUntil = markedAt + ROTATION_CHECK_INTERVAL_MS;
      return 0;
    }
    answer = null;
    const due = await keys.listWrappedUnder({ kids, releasedBy: now, limit: ROTATION_BATCH });
    if (due.length === 0) {
      const heldUntil = await keys.nextHoldEnd({ kids, after: now });
      if (heldUntil === null) {
        await complete(markedAt, at);
        pause.resume();
        return 0;
      }
      restUntil = Math.min(heldUntil.getTime(), at + ROTATION_CHECK_INTERVAL_MS);
    }
    if (markedAt > 0) await checkpoints.remove(marker);
    let rewrapped = 0;
    let kept = true;
    for (const row of due) {
      // A lease that lapsed while this instance stalled was taken by another, which goes on.
      if (!(await lease.take(clock.now().getTime()))) break;
      const outcome = await rewrap(row, at);
      if (outcome.rewrapped) rewrapped += 1;
      kept &&= outcome.kept;
    }
    pause.settle(at, kept);
    if (rewrapped > 0) rewrappedAny = true;
    return rewrapped;
  };

  const read = async (now: Date): Promise<Answer> => {
    const at = now.getTime();
    const later = at + ROTATION_CHECK_INTERVAL_MS;
    if ((await checkpoints.get(marker)) > 0) return { next: null, until: later };
    const [due] = await keys.listWrappedUnder({ kids, releasedBy: now, limit: 1 });
    if (due !== undefined) return { next: at, until: later };
    const heldUntil = (await keys.nextHoldEnd({ kids, after: now }))?.getTime() ?? null;
    return { next: heldUntil, until: Math.min(heldUntil ?? later, later) };
  };

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (pause.isPaused(at) || at < completeUntil || at < restUntil) return 0;
      try {
        return await sweep(now);
      } catch (error) {
        pause.pause(at);
        logger.error("personal keys to rewrap could not be listed", { error });
        return 0;
      }
    },
    // A mark that stands, however old, wakes nothing: the passes check it again as they run.
    nextDueAt: async () => {
      const now = clock.now();
      const at = now.getTime();
      if (at < completeUntil) return null;
      if (answer === null || at >= answer.until) answer = await read(now);
      return answer.next === null
        ? null
        : new Date(pause.notBefore(Math.max(answer.next, restUntil, lease.heldElsewhereUntil())));
    },
    status: async () => {
      const [pending, markedAt] = await Promise.all([
        keys.countWrappedUnder({ kids }),
        checkpoints.get(marker),
      ]);
      return {
        kid: wrapper.kid,
        previous,
        pending,
        completeAt: markedAt === 0 ? null : new Date(markedAt).toISOString(),
      };
    },
    release: lease.release,
    restored: async (first) => {
      completeUntil = Number.NEGATIVE_INFINITY;
      restUntil = Number.NEGATIVE_INFINITY;
      answer = null;
      pause.resume();
      lease.reset();
      if (!first) return;
      await keys.releaseHolds().catch((error: unknown) => {
        logger.error("personal keys' holds could not be cleared", { error });
      });
    },
  };
};
