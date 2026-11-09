import { isReleasedBy } from "../adapter/storage/hold.ts";
import type { PersonStore, StoredPerson } from "../adapter/storage/person-store.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";
import { earliestHoldEnd } from "./holds.ts";

export interface KeptPersonStore extends WithEntries<PersonStore, string> {
  /**
   * Whether the processing of the person's data is restricted, answered at once: the memory event
   * store checks it in the same step as it writes.
   */
  restricted(person: string): boolean;
  /**
   * The person's last activity recorded since their last forgetting as a whole, answered at once;
   * `null` without one.
   */
  lastActiveAt(person: string): string | null;
}

export interface CreateKeptPersonStoreFunction {
  (): KeptPersonStore;
}

export type KeptPerson = StoredPerson;

export interface BlankPersonFunction {
  (person: string): KeptPerson;
}

// A row as a person who has none has it.
export const blankPerson: BlankPersonFunction = (person) => ({
  person,
  restrictedSince: null,
  lastActiveAt: null,
  forgottenAt: null,
  hold: null,
  position: 0,
});

const stored = (person: KeptPerson): StoredPerson => ({ ...person });

// As SQL orders text, by code unit rather than by locale.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isIdle = (
  kept: KeptPerson,
): kept is KeptPerson & {
  readonly lastActiveAt: string;
} => kept.lastActiveAt !== null && kept.forgottenAt === null && kept.restrictedSince === null;

export const createKeptPersonStore: CreateKeptPersonStoreFunction = () => {
  const persons = new Map<string, KeptPerson>();
  const existing = (person: string): KeptPerson => persons.get(person) ?? blankPerson(person);
  return {
    restricted: (person) => (persons.get(person)?.restrictedSince ?? null) !== null,
    lastActiveAt: (person) => {
      const kept = persons.get(person);
      return kept === undefined || kept.forgottenAt !== null ? null : kept.lastActiveAt;
    },
    store: {
      get: async (person) => {
        const kept = persons.get(person);
        return kept === undefined ? null : stored(kept);
      },
      restrict: async (person, since) => {
        const kept = existing(person);
        if (kept.restrictedSince !== null) return false;
        persons.set(person, { ...kept, restrictedSince: since.toISOString() });
        return true;
      },
      unrestrict: async (person) => {
        const kept = persons.get(person);
        if (kept === undefined || kept.restrictedSince === null) return false;
        persons.set(person, { ...kept, restrictedSince: null });
        return true;
      },
      record: async ({ person, position, lastActiveAt, forgottenAt }) => {
        const kept = existing(person);
        if (kept.position >= position) return;
        persons.set(person, {
          ...kept,
          position,
          lastActiveAt: lastActiveAt ?? kept.lastActiveAt,
          forgottenAt,
          hold: null,
        });
      },
      listIdle: async ({ activeBefore, releasedBy, limit }) => {
        const before = activeBefore?.toISOString();
        return [...persons.values()]
          .filter(isIdle)
          .filter((kept) => before === undefined || kept.lastActiveAt <= before)
          .filter((kept) => isReleasedBy(kept.hold, releasedBy))
          .sort((a, b) => compare(a.lastActiveAt, b.lastActiveAt) || compare(a.person, b.person))
          .slice(0, limit)
          .map(stored);
      },
      hold: async (person, lastActiveAt, hold) => {
        const kept = persons.get(person);
        if (kept?.lastActiveAt === lastActiveAt && kept.forgottenAt === null) {
          persons.set(person, { ...kept, hold });
        }
      },
      nextHoldEnd: async (after) =>
        earliestHoldEnd(
          [...persons.values()].filter(isIdle).map(({ hold }) => hold),
          after,
        ),
    },
    entries: createStoreEntries(persons, (person) => person),
  };
};
