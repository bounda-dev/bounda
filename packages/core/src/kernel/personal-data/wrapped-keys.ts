import type {
  PersonalKeyStore,
  RewrappedKey,
  StoredPersonalKey,
} from "../../adapter/storage/personal-key-store.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import { fingerprintOf, fromBase64, toBase64 } from "./crypto.ts";
import type { KeyWrapper, KeyWrapperDefinition } from "./key-wrapper.ts";

/**
 * How many unwrapped keys an app keeps, least recently used out first.
 */
export const UNWRAPPED_KEYS_KEPT = 10_000;

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
}

export interface CreatePersonalKeyWrappingArgs {
  readonly wrapper: KeyWrapper | null;
  /**
   * How many unwrapped keys to keep. Defaults to `UNWRAPPED_KEYS_KEPT`.
   */
  readonly keep?: number;
}

export interface CreatePersonalKeyWrappingFunction {
  (args: CreatePersonalKeyWrappingArgs): PersonalKeyWrapping;
}

/**
 * The unwrapped keys are kept by fingerprint, which names one key whatever it is wrapped under,
 * but only ever looked up after the person's row was read: a key forgotten on another instance is
 * gone at once here too, even with unwrapping remote and slow.
 */
export const createPersonalKeyWrapping: CreatePersonalKeyWrappingFunction = ({
  wrapper,
  keep = UNWRAPPED_KEYS_KEPT,
}) => {
  const kept = new Map<string, Promise<string>>();
  // Whose fingerprint each person read here holds, so forgetting them drops their key at once.
  const fingerprints = new Map<string, string>();
  const known = new Set(wrapper === null ? [] : [wrapper.kid, ...(wrapper.previous ?? [])]);

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

  const unwrapped = async (stored: StoredPersonalKey): Promise<StoredPersonalKey> => {
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
    let raw = kept.get(stored.fingerprint);
    if (raw === undefined) {
      const unwrapping = unwrap(wrapper, { ...stored, kid });
      raw = unwrapping;
      kept.set(stored.fingerprint, unwrapping);
      unwrapping.catch(() => {
        if (kept.get(stored.fingerprint) === unwrapping) kept.delete(stored.fingerprint);
      });
      if (kept.size > keep) {
        const [oldest] = kept.keys();
        if (oldest !== undefined) kept.delete(oldest);
      }
    } else {
      kept.delete(stored.fingerprint);
      kept.set(stored.fingerprint, raw);
    }
    return { key: await raw, fingerprint: stored.fingerprint, kid: null };
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
        if (stored === null) return null;
        fingerprints.set(person, stored.fingerprint);
        return unwrapped(stored);
      },
      add: async (person, key) => {
        const stored = await keys.add(person, {
          ...(await wrapped(key)),
          fingerprint: key.fingerprint,
        });
        fingerprints.set(person, stored.fingerprint);
        return unwrapped(stored);
      },
      // What this instance unwrapped goes with the row; another instance's goes when evicted, and
      // is never read again, since every read starts from the row.
      remove: async (person) => {
        const removed = await keys.remove(person);
        const fingerprint = fingerprints.get(person);
        if (fingerprint !== undefined) kept.delete(fingerprint);
        fingerprints.delete(person);
        return removed;
      },
      listWrappedUnder: (args) => keys.listWrappedUnder(args),
      rewrap: (person, from, to) => keys.rewrap(person, from, to),
    }),
  };
};

export interface BuildPersonalKeyWrappingArgs {
  readonly definition: KeyWrapperDefinition | null;
  readonly env: AppEnv;
}

export interface BuildPersonalKeyWrappingFunction {
  (args: BuildPersonalKeyWrappingArgs): Promise<PersonalKeyWrapping>;
}

export const buildPersonalKeyWrapping: BuildPersonalKeyWrappingFunction = async ({
  definition,
  env,
}) =>
  createPersonalKeyWrapping({
    wrapper: definition === null ? null : await definition.create({ env }),
  });
