import type { PersonStore, StoredPerson } from "../adapter/storage/person-store.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";

export interface CreateKeptPersonStoreFunction {
  (): WithEntries<PersonStore, string>;
}

export const createKeptPersonStore: CreateKeptPersonStoreFunction = () => {
  const persons = new Map<string, StoredPerson>();
  return {
    store: {
      get: async (person) => persons.get(person) ?? null,
      restrict: async (person, since) => {
        const existing = persons.get(person);
        if (existing !== undefined && existing.restrictedSince !== null) return false;
        persons.set(person, { person, restrictedSince: since.toISOString() });
        return true;
      },
      unrestrict: async (person) => {
        const existing = persons.get(person);
        if (existing === undefined || existing.restrictedSince === null) return false;
        persons.set(person, { ...existing, restrictedSince: null });
        return true;
      },
    },
    entries: createStoreEntries(persons, (person) => person),
  };
};
