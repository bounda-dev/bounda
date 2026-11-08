import type {
  PersonalKeyStore,
  RewrappedKey,
  StoredPersonalKey,
} from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import { fingerprintOf, fromBase64, toBase64 } from "./crypto.ts";
import type { KeyWrapper, KeyWrapperDefinition } from "./key-wrapper.ts";

/**
 * How many unwrapped keys an app keeps, least recently used out first.
 */
export const UNWRAPPED_KEYS_KEPT = 10_000;

/**
 * How long an unwrapped key is kept from the moment it was unwrapped, however often it is read
 * since: five minutes cover the commands and reactions a person's activity sets off, so a remote
 * unwrap is paid about once a burst, and bound how long the raw key of someone no longer active
 * stays reachable in the process, idle or not.
 */
export const UNWRAPPED_KEY_TTL_MS: number = 5 * 60_000;

export interface PersonalKeyWrapping {
  /**
   * `null` without a key wrapper: keys are kept as they are.
   */
  readonly wrapper: KeyWrapper | null;
  /**
   * The key as the kernel uses it, `kid: null`, from the key as the store keeps it.
   */
  unwrapped(stored: StoredPersonalKey): Promise<StoredPersonalKey>;
  /**
   * The unwrapped key wrapped under the wrapper's `kid`, or as it is without a wrapper.
   */
  wrapped(key: StoredPersonalKey): Promise<RewrappedKey>;
  /**
   * `keys` as the kernel reads and writes them: unwrapped out of `get` and `add`, wrapped into
   * the store.
   */
  over(keys: PersonalKeyStore): PersonalKeyStore;
  /**
   * Drops every unwrapped key and the timer that expires them.
   */
  close(): void;
}

export interface CreatePersonalKeyWrappingArgs {
  readonly wrapper: KeyWrapper | null;
  readonly clock: Clock;
  /**
   * How many unwrapped keys to keep. Defaults to `UNWRAPPED_KEYS_KEPT`.
   */
  readonly keep?: number;
  /**
   * Defaults to `UNWRAPPED_KEY_TTL_MS`.
   */
  readonly ttlMs?: number;
}

export interface CreatePersonalKeyWrappingFunction {
  (args: CreatePersonalKeyWrappingArgs): PersonalKeyWrapping;
}

interface KeptKey {
  readonly raw: Promise<string>;
  readonly expiresAt: number;
  // Whose key it is, once a read of their row named them, so forgetting them drops it at once.
  person: string | null;
}

/**
 * The unwrapped keys are kept by fingerprint, which names one key whatever it is wrapped under,
 * but only ever looked up after the person's row was read: a key forgotten on another instance is
 * gone at once here too, even with unwrapping remote and slow. A key is dropped when it has been
 * kept `ttlMs`, by a timer armed for the first to expire, so nothing outlives its time in an
 * instance that reads no key any more.
 */
export const createPersonalKeyWrapping: CreatePersonalKeyWrappingFunction = ({
  wrapper,
  clock,
  keep = UNWRAPPED_KEYS_KEPT,
  ttlMs = UNWRAPPED_KEY_TTL_MS,
}) => {
  // Least recently read first.
  const kept = new Map<string, KeptKey>();
  // Unwrapped first, which, kept as long as each other, is also the first to expire.
  const unwrappedAt = new Map<string, KeptKey>();
  const known = new Set(wrapper === null ? [] : [wrapper.kid, ...(wrapper.previous ?? [])]);
  let cancelExpiry: (() => void) | null = null;

  const drop = (fingerprint: string): void => {
    kept.delete(fingerprint);
    unwrappedAt.delete(fingerprint);
  };

  const armExpiry = (): void => {
    const [first] = unwrappedAt.values();
    if (cancelExpiry !== null || first === undefined) return;
    cancelExpiry = clock.after(first.expiresAt - clock.now().getTime(), expire);
  };

  const expire = (): void => {
    cancelExpiry = null;
    const now = clock.now().getTime();
    for (const [fingerprint, key] of unwrappedAt) {
      if (key.expiresAt > now) break;
      drop(fingerprint);
    }
    armExpiry();
  };

  const unwrap = async (wrapping: KeyWrapper, stored: StoredPersonalKey & { kid: string }) => {
    const raw = Uint8Array.from(
      await wrapping.unwrap({ kid: stored.kid, wrapped: fromBase64(stored.key) }),
    );
    if ((await fingerprintOf(raw)) !== stored.fingerprint) {
      throw new ConfigurationError(
        `A personal key unwrapped under ${stored.kid} does not match its fingerprint: the key wrapper returned another key`,
      );
    }
    return toBase64(raw);
  };

  const unwrapped = async (
    stored: StoredPersonalKey,
    person?: string,
  ): Promise<StoredPersonalKey> => {
    const { kid } = stored;
    if (kid === null) return stored;
    if (wrapper === null) {
      throw new ConfigurationError(
        `A personal key is wrapped under ${kid}, and runtime.personalData.keyWrapper is not set`,
      );
    }
    if (!known.has(kid)) {
      throw new ConfigurationError(
        `A personal key is wrapped under ${kid}, which is neither the key wrapper's key nor one of its previous ones`,
      );
    }
    const { fingerprint } = stored;
    let entry = kept.get(fingerprint);
    // Dropped first, so the key unwrapped again goes to the end of both orders.
    if (entry === undefined || entry.expiresAt <= clock.now().getTime()) {
      drop(fingerprint);
      const unwrapping = unwrap(wrapper, { ...stored, kid });
      const created: KeptKey = {
        raw: unwrapping,
        expiresAt: clock.now().getTime() + ttlMs,
        person: null,
      };
      entry = created;
      kept.set(fingerprint, created);
      unwrappedAt.set(fingerprint, created);
      unwrapping.catch(() => {
        if (kept.get(fingerprint) === created) drop(fingerprint);
      });
      const [oldest] = kept.keys();
      if (kept.size > keep && oldest !== undefined) drop(oldest);
      armExpiry();
    } else {
      kept.delete(fingerprint);
      kept.set(fingerprint, entry);
    }
    if (person !== undefined) entry.person = person;
    return { key: await entry.raw, fingerprint, kid: null };
  };

  const wrapped = async (key: StoredPersonalKey): Promise<RewrappedKey> => {
    if (wrapper === null) return { key: key.key, kid: key.kid };
    const raw = fromBase64((await unwrapped(key)).key);
    return { key: toBase64(await wrapper.wrap(raw)), kid: wrapper.kid };
  };

  return {
    wrapper,
    unwrapped,
    wrapped,
    over: (keys) => ({
      get: async (person) => {
        const stored = await keys.get(person);
        return stored === null ? null : unwrapped(stored, person);
      },
      add: async (person, key) => {
        const stored = await keys.add(person, {
          ...(await wrapped(key)),
          fingerprint: key.fingerprint,
        });
        return unwrapped(stored, person);
      },
      // What this instance unwrapped goes with the row; another instance's goes when it expires,
      // and is never read again meanwhile, since every read starts from the row.
      remove: async (person) => {
        const removed = await keys.remove(person);
        for (const [fingerprint, key] of kept) if (key.person === person) drop(fingerprint);
        return removed;
      },
      listWrappedUnder: (args) => keys.listWrappedUnder(args),
      rewrap: (person, from, to) => keys.rewrap(person, from, to),
      hold: (person, from, hold) => keys.hold(person, from, hold),
      nextHoldEnd: (args) => keys.nextHoldEnd(args),
    }),
    close: () => {
      cancelExpiry?.();
      cancelExpiry = null;
      for (const fingerprint of [...kept.keys()]) drop(fingerprint);
    },
  };
};

export interface BuildPersonalKeyWrappingArgs {
  readonly definition: KeyWrapperDefinition | null;
  readonly env: AppEnv;
  readonly clock: Clock;
}

export interface BuildPersonalKeyWrappingFunction {
  (args: BuildPersonalKeyWrappingArgs): Promise<PersonalKeyWrapping>;
}

export const buildPersonalKeyWrapping: BuildPersonalKeyWrappingFunction = async ({
  definition,
  env,
  clock,
}) =>
  createPersonalKeyWrapping({
    wrapper: definition === null ? null : await definition.create({ env }),
    clock,
  });
