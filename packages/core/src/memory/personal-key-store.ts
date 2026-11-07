import type { Hold } from "../adapter/storage/hold.ts";
import type {
  KeyedPerson,
  PersonalKeyStore,
  StoredPersonalKey,
} from "../adapter/storage/personal-key-store.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";

export interface KeptPersonalKeyStore extends WithEntries<PersonalKeyStore, string> {
  /**
   * Whether the person holds the key of that fingerprint, always for a `null` one, answered
   * at once: the memory snapshot store checks it in the same step as it writes, so no forget runs
   * between the two.
   */
  holds(held: KeyedPerson): boolean;
  /**
   * The fingerprint of the person's key, `null` when they hold none, answered at once for the
   * same reason.
   */
  fingerprintOf(person: string): string | null;
}

export interface CreateKeptPersonalKeyStoreFunction {
  (): KeptPersonalKeyStore;
}

interface KeptPersonalKey extends StoredPersonalKey {
  readonly hold: Hold | null;
}

const stored = ({ hold: _hold, ...key }: KeptPersonalKey): StoredPersonalKey => key;

const isHeldBy = (held: StoredPersonalKey | undefined, from: StoredPersonalKey): boolean =>
  held?.key === from.key && held.fingerprint === from.fingerprint;

export const createKeptPersonalKeyStore: CreateKeptPersonalKeyStoreFunction = () => {
  const keys = new Map<string, KeptPersonalKey>();
  return {
    holds: ({ person, fingerprint }) => {
      const stored = keys.get(person);
      return fingerprint === null || stored?.fingerprint === fingerprint;
    },
    fingerprintOf: (person) => keys.get(person)?.fingerprint ?? null,
    store: {
      get: async (person) => {
        const kept = keys.get(person);
        return kept === undefined ? null : stored(kept);
      },
      add: async (person, key) => {
        const existing = keys.get(person);
        if (existing !== undefined) return stored(existing);
        const kept = { key: key.key, fingerprint: key.fingerprint, kid: key.kid, hold: null };
        keys.set(person, kept);
        return stored(kept);
      },
      remove: async (person) => keys.delete(person),
      listWrappedUnder: async ({ kids, releasedBy, limit }) => {
        const released = releasedBy?.toISOString();
        return (
          [...keys.entries()]
            .filter(([, key]) => kids.includes(key.kid))
            .filter(
              ([, { hold }]) => released === undefined || hold === null || hold.until <= released,
            )
            // Persons are unique, so no two compare equal.
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .slice(0, limit)
            .map(([person, key]) => ({ person, key: stored(key), hold: key.hold }))
        );
      },
      rewrap: async (person, from, to) => {
        const held = keys.get(person);
        if (held === undefined || !isHeldBy(held, from)) return false;
        keys.set(person, { ...held, key: to.key, kid: to.kid, hold: null });
        return true;
      },
      hold: async (person, from, hold) => {
        const held = keys.get(person);
        if (held !== undefined && isHeldBy(held, from)) keys.set(person, { ...held, hold });
      },
      nextHoldEnd: async ({ kids, after }) => {
        const from = after.toISOString();
        const ends = [...keys.values()]
          .filter((key) => kids.includes(key.kid))
          .flatMap(({ hold }) => (hold !== null && hold.until > from ? [hold.until] : []))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return ends[0] === undefined ? null : new Date(ends[0]);
      },
    },
    entries: createStoreEntries(keys, (person) => person),
  };
};
