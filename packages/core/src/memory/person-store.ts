import type { RestrictionRead } from "../adapter/storage/append-checks.ts";
import { isReleasedBy } from "../adapter/storage/hold.ts";
import type {
  PersonStore,
  StoredPerson,
  StoredRestriction,
} from "../adapter/storage/person-store.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";
import { earliestHoldEnd } from "./holds.ts";

export interface KeptPersonStore extends WithEntries<PersonStore, string> {
  /**
   * The person's restrictions, answered at once: the memory event store checks them in the same
   * step as it writes.
   */
  restrictionsOf(person: string): readonly RestrictionRead[];
  /**
   * Whether the category is restricted for the person, or they are as a whole.
   */
  restricted(person: string, category: string): boolean;
  /**
   * The person's last activity recorded since their last forgetting as a whole, answered at once;
   * `null` without one.
   */
  lastActiveAt(person: string): string | null;
}

export interface CreateKeptPersonStoreFunction {
  (): KeptPersonStore;
}

// The restrictions ride on the row, so a transaction that stages the row stages them too.
export interface KeptPerson extends StoredPerson {
  readonly restrictions: readonly StoredRestriction[];
}

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
  restrictions: [],
});

const stored = ({ restrictions: _restrictions, ...person }: KeptPerson): StoredPerson => ({
  ...person,
});

const oldest = (restrictions: readonly StoredRestriction[]): string | null =>
  restrictions.reduce<string | null>(
    (first, { since }) => (first === null || since < first ? since : first),
    null,
  );

// Oldest first, as SQL orders them.
const inOrder = (restrictions: readonly StoredRestriction[]): readonly StoredRestriction[] =>
  [...restrictions].sort(
    (a, b) =>
      compare(a.since, b.since) ||
      compare(a.ground, b.ground) ||
      compare(a.category ?? "", b.category ?? ""),
  );

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
  const restrictionsOf = (person: string): readonly StoredRestriction[] =>
    persons.get(person)?.restrictions ?? [];
  const withRestrictions = (kept: KeptPerson, restrictions: readonly StoredRestriction[]) => {
    persons.set(kept.person, { ...kept, restrictions, restrictedSince: oldest(restrictions) });
  };
  return {
    restrictionsOf: (person) => restrictionsOf(person).map(({ category }) => ({ category })),
    restricted: (person, category) =>
      restrictionsOf(person).some((row) => row.category === null || row.category === category),
    lastActiveAt: (person) => {
      const kept = persons.get(person);
      return kept === undefined || kept.forgottenAt !== null ? null : kept.lastActiveAt;
    },
    store: {
      get: async (person) => {
        const kept = persons.get(person);
        return kept === undefined ? null : stored(kept);
      },
      restrictions: async (person) => inOrder(restrictionsOf(person)),
      restrict: async (person, { ground, categories, since }) => {
        const kept = existing(person);
        const on = kept.restrictions.filter((row) => row.ground === ground);
        if (on.some((row) => row.category === null)) return false;
        const at = since.toISOString();
        if (categories === null) {
          withRestrictions(kept, [
            ...kept.restrictions.filter((row) => row.ground !== ground),
            { ground, category: null, since: at },
          ]);
          return true;
        }
        const added = [...new Set(categories)]
          .filter((category) => !on.some((row) => row.category === category))
          .map((category) => ({ ground, category, since: at }));
        if (added.length === 0) return false;
        withRestrictions(kept, [...kept.restrictions, ...added]);
        return true;
      },
      unrestrict: async (person, { ground, categories }) => {
        const kept = persons.get(person);
        if (kept === undefined) return [];
        const matches = (row: StoredRestriction): boolean =>
          (ground === undefined || row.ground === ground) &&
          (categories === null || (row.category !== null && categories.includes(row.category)));
        const removed = kept.restrictions.filter(matches);
        if (removed.length === 0) return [];
        withRestrictions(
          kept,
          kept.restrictions.filter((row) => !matches(row)),
        );
        return [...new Set(removed.map((row) => row.ground))].sort();
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
      countIdle: async ({ activeBefore }) => {
        const before = activeBefore?.toISOString();
        return [...persons.values()]
          .filter(isIdle)
          .filter((kept) => before === undefined || kept.lastActiveAt <= before).length;
      },
      releaseHolds: async () => {
        let released = 0;
        for (const [person, kept] of persons) {
          if (kept.hold === null) continue;
          persons.set(person, { ...kept, hold: null });
          released += 1;
        }
        return released;
      },
    },
    entries: createStoreEntries(persons, (person) => person),
  };
};
