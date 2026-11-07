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
}

export interface CreateKeptPersonalKeyStoreFunction {
  (): KeptPersonalKeyStore;
}

export const createKeptPersonalKeyStore: CreateKeptPersonalKeyStoreFunction = () => {
  const keys = new Map<string, StoredPersonalKey>();
  return {
    holds: ({ person, fingerprint }) => {
      const stored = keys.get(person);
      return fingerprint === null || stored?.fingerprint === fingerprint;
    },
    store: {
      get: async (person) => keys.get(person) ?? null,
      add: async (person, key) => {
        const existing = keys.get(person);
        if (existing !== undefined) return existing;
        keys.set(person, key);
        return key;
      },
      remove: async (person) => keys.delete(person),
      listWrappedUnder: async ({ kids, limit }) =>
        [...keys.entries()]
          .filter(([, key]) => kids.includes(key.kid))
          // Persons are unique, so no two compare equal.
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .slice(0, limit)
          .map(([person, key]) => ({ person, key })),
      rewrap: async (person, from, to) => {
        const held = keys.get(person);
        if (held === undefined || held.key !== from.key || held.fingerprint !== from.fingerprint) {
          return false;
        }
        keys.set(person, { ...held, key: to.key, kid: to.kid });
        return true;
      },
    },
    entries: createStoreEntries(keys, (person) => person),
  };
};
