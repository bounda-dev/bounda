import type { PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { errorDetails } from "../shared/retry.ts";
import type { KeyWrapper } from "./key-wrapper.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

// How many keys a pass of the worker rewraps at most.
export const ROTATION_BATCH = 50;

// How long the rotation rests after finding nothing to rewrap: a key an instance still on the old
// wrapping key writes meanwhile, as in a rolling deploy, waits this long.
export const ROTATION_CHECK_INTERVAL_MS = 60_000;

// How long a key that failed to rewrap waits, twice as long after each failure up to
// `ROTATION_MAX_RETRY_MS`; and how long a list that could not be read holds the rotation.
export const ROTATION_RETRY_MS = 30_000;

export const ROTATION_MAX_RETRY_MS = 3_600_000;

interface Hold {
  readonly until: number;
  readonly failures: number;
}

export interface KeyRotation {
  /**
   * Rewraps under the wrapper's key up to `ROTATION_BATCH` keys wrapped under a previous one or
   * kept unwrapped, and resolves to how many it rewrapped. Never rejects: what fails is logged and
   * tried again later, a key on its own.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next pass has a key to rewrap, a held one not before its hold ends; `null` when there
   * is none.
   */
  nextDueAt(): Promise<Date | null>;
}

export interface CreateKeyRotationArgs {
  /**
   * The store as written, whose keys are read and written wrapped.
   */
  readonly keys: PersonalKeyStore;
  readonly wrapper: KeyWrapper;
  readonly wrapping: PersonalKeyWrapping;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateKeyRotationFunction {
  (args: CreateKeyRotationArgs): KeyRotation;
}

/**
 * Keys wrapped under a previous key, and keys from before a wrapper was configured, are
 * rewrapped under the current one; a key forgotten or replaced while it was being rewrapped is
 * left as the store holds it. Once none is left the rotation logs it, once until it rewraps again,
 * so an operator knows the previous keys can go.
 */
export const createKeyRotation: CreateKeyRotationFunction = ({
  keys,
  wrapper,
  wrapping,
  clock,
  logger,
}) => {
  // A wrapper that names its own key among the previous ones would rewrap it on every pass.
  const previous = (wrapper.previous ?? []).filter((kid) => kid !== wrapper.kid);
  const kids = [...previous, null];
  const holds = new Map<string, Hold>();
  let restUntil = Number.NEGATIVE_INFINITY;
  let reported = false;
  let rewrappedAny = false;

  const hold = (person: string, now: number): void => {
    const failures = (holds.get(person)?.failures ?? 0) + 1;
    const delay = Math.min(ROTATION_RETRY_MS * 2 ** (failures - 1), ROTATION_MAX_RETRY_MS);
    holds.set(person, { until: now + delay, failures });
  };

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

  const sweep = async (at: number): Promise<number> => {
    const rows = await keys.listWrappedUnder({ kids, limit: ROTATION_BATCH + holds.size });
    // A key no longer listed was rewrapped or forgotten: its hold goes with it.
    const listed = new Set(rows.map(({ person }) => person));
    for (const person of holds.keys()) if (!listed.has(person)) holds.delete(person);
    if (rows.length === 0) {
      restUntil = at + ROTATION_CHECK_INTERVAL_MS;
      if (!reported) report();
      reported = true;
      return 0;
    }
    const due = rows
      .filter(({ person }) => (holds.get(person)?.until ?? at) <= at)
      .slice(0, ROTATION_BATCH);
    let rewrapped = 0;
    for (const { person, key } of due) {
      try {
        if (await keys.rewrap(person, key, await wrapping.wrapped(key))) rewrapped += 1;
      } catch (error) {
        hold(person, at);
        logger.error("personal key could not be rewrapped", {
          personId: person,
          kid: key.kid,
          ...errorDetails(error),
        });
      }
    }
    if (rewrapped > 0) {
      reported = false;
      rewrappedAny = true;
    }
    return rewrapped;
  };

  return {
    sweep: async (now) => {
      const at = now.getTime();
      if (at < restUntil) return 0;
      try {
        return await sweep(at);
      } catch (error) {
        restUntil = at + ROTATION_RETRY_MS;
        logger.error("personal keys to rewrap could not be listed", errorDetails(error));
        return 0;
      }
    },
    nextDueAt: async () => {
      const rows = await keys.listWrappedUnder({ kids, limit: 1 + holds.size });
      let next = Number.POSITIVE_INFINITY;
      for (const { person } of rows) {
        const held = holds.get(person)?.until;
        if (held === undefined) {
          next = clock.now().getTime();
          break;
        }
        next = Math.min(next, held);
      }
      return next === Number.POSITIVE_INFINITY ? null : new Date(Math.max(next, restUntil));
    },
  };
};
