import type { PersonalKeyStore } from "../adapter/storage/personal-key-store.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";

export interface KeptPersonalKeyStore extends WithEntries<PersonalKeyStore, string> {
  /**
   * Whether `person` has a key, answered at once: the memory snapshot store checks it in the
   * same step as it writes, so no forget runs between the two.
   */
  holds(person: string): boolean;
}

export interface CreateKeptPersonalKeyStoreFunction {
  (): KeptPersonalKeyStore;
}

export const createKeptPersonalKeyStore: CreateKeptPersonalKeyStoreFunction = () => {
  const keys = new Map<string, string>();
  return {
    holds: (person) => keys.has(person),
    store: {
      get: async (person) => keys.get(person) ?? null,
      add: async (person, key) => {
        const existing = keys.get(person);
        if (existing !== undefined) return existing;
        keys.set(person, key);
        return key;
      },
      remove: async (person) => keys.delete(person),
    },
    entries: createStoreEntries(keys, (person) => person),
  };
};

export interface CreateMemoryPersonalKeyStoreFunction {
  (): PersonalKeyStore;
}

export const createMemoryPersonalKeyStore: CreateMemoryPersonalKeyStoreFunction = () =>
  createKeptPersonalKeyStore().store;
