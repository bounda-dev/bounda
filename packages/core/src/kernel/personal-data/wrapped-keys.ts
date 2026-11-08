import type {
  PersonalKeyStore,
  RewrappedKey,
  StoredPersonalKey,
} from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import {
  fingerprintOf,
  fromBase64,
  generateWrappableKey,
  importRawKey,
  type PersonalKey,
  toBase64,
  withRawKey,
} from "./crypto.ts";
import {
  buildKeyWrapper,
  type CryptoKeyWrapper,
  type KeyWrapperDefinition,
} from "./key-wrapper.ts";

/**
 * How many keys an app keeps, least recently used out first.
 */
export const UNWRAPPED_KEYS_KEPT = 10_000;

/**
 * How long a key is kept from the moment it was unwrapped, however often it is read since: long
 * enough to cover the commands and reactions one burst of a person's activity sets off, so a
 * remote unwrap is paid about once a burst, and short enough that the key of someone no longer
 * active does not stay usable in the process, idle or not.
 */
export const UNWRAPPED_KEY_TTL_MS: number = 5 * 60_000;

/**
 * A transaction's or the storage's keys as the kernel uses them: the store as written, and the
 * person's key ready to seal and open with.
 */
const OLDER_DATABASE =
  "or the database was written before fingerprints were key check values and must be created anew";

export interface PersonalKeys extends PersonalKeyStore {
  /**
   * The key the person holds, `null` when they hold none.
   */
  held(person: string): Promise<PersonalKey | null>;
  /**
   * The key `stored` holds, as `get` read it for the person.
   */
  open(person: string, stored: StoredPersonalKey): Promise<PersonalKey>;
  /**
   * Stores a new key for the person unless one is in force, and resolves the one in force.
   */
  create(person: string): Promise<PersonalKey>;
}

export interface PersonalKeyWrapping {
  /**
   * `null` without a key wrapper: keys are kept as they are.
   */
  readonly wrapper: CryptoKeyWrapper | null;
  /**
   * The key wrapped under the wrapper's `kid`, or as it is without a wrapper. It is unwrapped for
   * that alone and not kept: the rotation rewraps the keys of persons nobody reads.
   */
  wrapped(key: StoredPersonalKey): Promise<RewrappedKey>;
  /**
   * Drops the person's key, for a forgetting made on the store as written.
   */
  drop(person: string): void;
  over(keys: PersonalKeyStore): PersonalKeys;
  /**
   * Drops every key kept and the timer that expires them.
   */
  close(): void;
}

export interface CreatePersonalKeyWrappingArgs {
  readonly wrapper: CryptoKeyWrapper | null;
  readonly clock: Clock;
  /**
   * How many keys to keep. Defaults to `UNWRAPPED_KEYS_KEPT`.
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
  readonly key: Promise<CryptoKey>;
  readonly expiresAt: number;
  readonly person: string;
}

/**
 * The keys are kept by fingerprint, which names one key whatever it is wrapped under, as keys that
 * cannot be exported, but only ever looked up after the person's row was read: a key forgotten on
 * another instance is gone at once here too, even with unwrapping remote and slow. A key kept
 * `ttlMs` is dropped at the next read of any key, and by a timer armed for the first to expire,
 * which a clock may decline to arm where a pending timer keeps the process awake.
 */
export const createPersonalKeyWrapping: CreatePersonalKeyWrappingFunction = ({
  wrapper,
  clock,
  keep = UNWRAPPED_KEYS_KEPT,
  ttlMs = UNWRAPPED_KEY_TTL_MS,
}) => {
  // Least recently read first.
  const kept = new Map<string, KeptKey>();
  // Kept first, which, kept as long as each other, is also the first to expire.
  const keptAt = new Map<string, KeptKey>();
  // The fingerprint kept for each person, so forgetting them drops their key at once.
  const byPerson = new Map<string, string>();
  const known = new Set(wrapper === null ? [] : [wrapper.kid, ...wrapper.previous]);
  let cancelExpiry: (() => void) | null = null;

  const drop = (fingerprint: string): void => {
    const person = kept.get(fingerprint)?.person;
    kept.delete(fingerprint);
    keptAt.delete(fingerprint);
    if (person !== undefined && byPerson.get(person) === fingerprint) byPerson.delete(person);
  };

  // A wall clock set back makes a key look younger than it can be: it is taken as expired.
  const isExpired = (key: KeptKey, now: number): boolean =>
    key.expiresAt <= now || key.expiresAt - now > ttlMs;

  const armExpiry = (): void => {
    const [first] = keptAt.values();
    if (cancelExpiry !== null || first === undefined) return;
    cancelExpiry = clock.after(first.expiresAt - clock.now().getTime(), expire, {
      background: true,
    });
  };

  const dropExpired = (now: number): void => {
    for (const [fingerprint, key] of keptAt) {
      if (!isExpired(key, now)) break;
      drop(fingerprint);
    }
  };

  const expire = (): void => {
    cancelExpiry = null;
    dropExpired(clock.now().getTime());
    armExpiry();
  };

  const wrapperFor = (kid: string): CryptoKeyWrapper => {
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
    return wrapper;
  };

  // Exportable only to be wrapped again, never to be kept.
  const unwrap = async (stored: StoredPersonalKey, extractable: boolean): Promise<CryptoKey> => {
    const { kid } = stored;
    const key =
      kid === null
        ? await importRawKey({ raw: fromBase64(stored.key), extractable })
        : await wrapperFor(kid).unwrap({ kid, wrapped: fromBase64(stored.key), extractable });
    if ((await fingerprintOf(key)) !== stored.fingerprint) {
      throw new ConfigurationError(
        kid === null
          ? `A personal key kept unwrapped does not match its fingerprint: the key was altered in the store, ${OLDER_DATABASE}`
          : `A personal key unwrapped under ${kid} does not match its fingerprint: the key wrapper returned another key, ${OLDER_DATABASE}`,
      );
    }
    return key;
  };

  const remember = (fingerprint: string, person: string, key: Promise<CryptoKey>): void => {
    const created: KeptKey = { key, expiresAt: clock.now().getTime() + ttlMs, person };
    kept.set(fingerprint, created);
    keptAt.set(fingerprint, created);
    byPerson.set(person, fingerprint);
    key.catch(() => {
      if (kept.get(fingerprint) === created) drop(fingerprint);
    });
    const [oldest] = kept.keys();
    if (kept.size > keep && oldest !== undefined) drop(oldest);
    armExpiry();
  };

  const open = async (person: string, stored: StoredPersonalKey): Promise<PersonalKey> => {
    const { kid, fingerprint } = stored;
    // Before the cache, so a key rewrapped under a kid this app does not know fails however
    // recently it was kept.
    if (kid !== null) wrapperFor(kid);
    dropExpired(clock.now().getTime());
    const entry = kept.get(fingerprint);
    if (entry === undefined) {
      const key = unwrap(stored, false);
      remember(fingerprint, person, key);
      return { fingerprint, cryptoKey: await key };
    }
    kept.delete(fingerprint);
    kept.set(fingerprint, entry);
    return { fingerprint, cryptoKey: await entry.key };
  };

  // The new key as the store keeps it, and as it is sealed with. Its raw bytes exist only without
  // a wrapper, to be stored as they are, or for a wrapper of the app's own.
  const generate = async (): Promise<{ stored: StoredPersonalKey; key: PersonalKey }> => {
    const exportable = await generateWrappableKey();
    const fingerprint = await fingerprintOf(exportable);
    if (wrapper === null) {
      return withRawKey(exportable, async (raw) => {
        const text = toBase64(raw);
        const cryptoKey = await importRawKey({ raw, extractable: false });
        return { stored: { key: text, fingerprint, kid: null }, key: { fingerprint, cryptoKey } };
      });
    }
    const { wrapped, key: cryptoKey } = await wrapper.wrap(exportable);
    return {
      stored: { key: toBase64(wrapped), fingerprint, kid: wrapper.kid },
      key: { fingerprint, cryptoKey },
    };
  };

  const wrapped = async (key: StoredPersonalKey): Promise<RewrappedKey> => {
    if (wrapper === null) return { key: key.key, kid: key.kid };
    const { wrapped: rewrapped } = await wrapper.wrap(await unwrap(key, true));
    return { key: toBase64(rewrapped), kid: wrapper.kid };
  };

  const dropPerson = (person: string): void => {
    const fingerprint = byPerson.get(person);
    if (fingerprint !== undefined) drop(fingerprint);
  };

  return {
    wrapper,
    wrapped,
    drop: dropPerson,
    over: (keys) => ({
      get: (person) => keys.get(person),
      // Wrapped on the way in, as every key the store keeps.
      add: async (person, key) =>
        keys.add(
          person,
          key.kid === (wrapper?.kid ?? null)
            ? key
            : { ...(await wrapped(key)), fingerprint: key.fingerprint },
        ),
      held: async (person) => {
        const stored = await keys.get(person);
        return stored === null ? null : open(person, stored);
      },
      open,
      create: async (person) => {
        const fresh = await generate();
        const inForce = await keys.add(person, fresh.stored);
        if (inForce.fingerprint !== fresh.key.fingerprint) return open(person, inForce);
        remember(fresh.key.fingerprint, person, Promise.resolve(fresh.key.cryptoKey));
        return fresh.key;
      },
      // What this instance kept goes with the row; another instance's goes when it expires, and
      // is never read again meanwhile, since every read starts from the row.
      remove: async (person) => {
        const removed = await keys.remove(person);
        dropPerson(person);
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
    wrapper: definition === null ? null : await buildKeyWrapper({ definition, env }),
    clock,
  });
