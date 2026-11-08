import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { PersonalKeyRow, PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { errorDetails } from "../shared/retry.ts";
import { fingerprintOf } from "./crypto.ts";
import { HOLD_MS, holdAfter } from "./hold.ts";
import type { KeyWrapper } from "./key-wrapper.ts";
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
}

export interface CreateKeyRotationArgs {
  /**
   * The store as written, whose keys are read and written wrapped.
   */
  readonly keys: PersonalKeyStore;
  readonly checkpoints: CheckpointStore;
  readonly wrapper: KeyWrapper;
  readonly wrapping: PersonalKeyWrapping;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateKeyRotationFunction {
  (args: CreateKeyRotationArgs): KeyRotation;
}

const markerOf = async (kid: string, previous: readonly string[]): Promise<string> => {
  const set = JSON.stringify([kid, ...[...new Set(previous)].sort()]);
  return `${ROTATED_PREFIX}${await fingerprintOf(new TextEncoder().encode(set))}`;
};

/**
 * Keys wrapped under a previous key, and keys from before a wrapper was configured, are
 * rewrapped under the current one; a key forgotten or replaced while it was being rewrapped is
 * left as the store holds it. Once none is left the rotation marks it complete for this set of
 * wrapping keys and logs it, once until it rewraps again, so an operator knows the previous keys
 * can go. While the mark stands nothing reads the key table, but a pass once every
 * `ROTATION_CHECK_INTERVAL_MS`, which drops the mark when it finds a key again.
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
  const previous = (wrapper.previous ?? []).filter((kid) => kid !== wrapper.kid);
  const kids = [...previous, null];
  const marker = markerOf(wrapper.kid, previous);
  // Until when this instance takes the rotation for complete without reading anything.
  let completeUntil = Number.NEGATIVE_INFINITY;
  // A list that could not be read, or a hold that could not be written, holds the whole rotation
  // here, as nothing else can.
  let pausedUntil = Number.NEGATIVE_INFINITY;
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

  // Of several instances finding it complete at once, the one that marks it first logs it; the
  // marks of other sets of keys go, since none stands for the keys as they are now.
  const complete = async (name: string, markedAt: number, at: number): Promise<void> => {
    completeUntil = at + ROTATION_CHECK_INTERVAL_MS;
    if (!(await checkpoints.compareAndSet(name, markedAt, at)) || markedAt > 0) return;
    report();
    for (const { subscriber } of await checkpoints.list()) {
      if (subscriber.startsWith(ROTATED_PREFIX) && subscriber !== name) {
        await checkpoints.remove(subscriber);
      }
    }
  };

  const hold = async ({ person, key, hold }: PersonalKeyRow, at: number): Promise<void> => {
    try {
      await keys.hold(person, key, holdAfter({ held: hold, at, failed: true }));
    } catch (error) {
      pausedUntil = at + HOLD_MS;
      logger.error("personal key could not be held", {
        personId: person,
        kid: key.kid,
        ...errorDetails(error),
      });
    }
  };

  const sweep = async (now: Date): Promise<number> => {
    const at = now.getTime();
    const name = await marker;
    const markedAt = await checkpoints.get(name);
    // A set never marked reads 0, as long ago as can be.
    if (at - markedAt < ROTATION_CHECK_INTERVAL_MS) {
      completeUntil = markedAt + ROTATION_CHECK_INTERVAL_MS;
      return 0;
    }
    const due = await keys.listWrappedUnder({ kids, releasedBy: now, limit: ROTATION_BATCH });
    if (due.length === 0) {
      if ((await keys.nextHoldEnd({ kids, after: now })) === null) {
        await complete(name, markedAt, at);
      } else if (markedAt > 0) {
        await checkpoints.remove(name);
      }
      return 0;
    }
    if (markedAt > 0) await checkpoints.remove(name);
    let rewrapped = 0;
    for (const row of due) {
      try {
        if (await keys.rewrap(row.person, row.key, await wrapping.wrapped(row.key))) rewrapped += 1;
      } catch (error) {
        logger.error("personal key could not be rewrapped", {
          personId: row.person,
          kid: row.key.kid,
          ...errorDetails(error),
        });
        await hold(row, at);
      }
    }
    if (rewrapped > 0) rewrappedAny = true;
    return rewrapped;
  };

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (at < pausedUntil || at < completeUntil) return 0;
      try {
        return await sweep(now);
      } catch (error) {
        pausedUntil = at + HOLD_MS;
        logger.error("personal keys to rewrap could not be listed", errorDetails(error));
        return 0;
      }
    },
    nextDueAt: async () => {
      const now = clock.now();
      const at = now.getTime();
      if (at < completeUntil) return null;
      // A mark that stands, however old, wakes nothing: the passes check it again as they run.
      if ((await checkpoints.get(await marker)) > 0) {
        completeUntil = at + ROTATION_CHECK_INTERVAL_MS;
        return null;
      }
      const [due] = await keys.listWrappedUnder({ kids, releasedBy: now, limit: 1 });
      const next =
        due === undefined
          ? ((await keys.nextHoldEnd({ kids, after: now }))?.getTime() ?? null)
          : at;
      return next === null ? null : new Date(Math.max(next, pausedUntil));
    },
  };
};
