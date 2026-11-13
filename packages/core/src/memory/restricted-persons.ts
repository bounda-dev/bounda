import {
  RETAINED_SOURCE,
  type RestrictedPerson,
  type RestrictedPersonsStore,
} from "../adapter/storage/restricted-persons.ts";

export interface MemoryRestrictedPersons {
  readonly store: RestrictedPersonsStore;
  restrictionsOf(person: string): readonly Omit<RestrictedPerson, "person">[];
  // Returns what puts the rows back the way they were.
  snapshot(): () => void;
  rows(): readonly RestrictedPerson[];
  positions(): readonly { readonly person: string; readonly position: number }[];
}

export interface CreateMemoryRestrictedPersonsFunction {
  (): MemoryRestrictedPersons;
}

/**
 * The read side's copy of who is restricted, for the in-memory adapter: one per adapter, as one
 * per database.
 */
export const createMemoryRestrictedPersons: CreateMemoryRestrictedPersonsFunction = () => {
  let rows: readonly RestrictedPerson[] = [];
  let positions: ReadonlyMap<string, number> = new Map();
  const add = (row: RestrictedPerson): void => {
    const same = rows.some(
      (kept) =>
        kept.person === row.person && kept.source === row.source && kept.category === row.category,
    );
    if (!same) rows = [...rows, row];
  };
  return {
    store: {
      advance: async (person, position) => {
        if ((positions.get(person) ?? 0) >= position) return false;
        positions = new Map([...positions, [person, position]]);
        return true;
      },
      request: async (person, restrictions) => {
        rows = rows.filter((row) => row.person !== person || row.source === RETAINED_SOURCE);
        for (const { ground, categories } of restrictions) {
          for (const category of categories ?? [null]) add({ person, source: ground, category });
        }
      },
      retain: async (person, categories) => {
        for (const category of categories) add({ person, source: RETAINED_SOURCE, category });
      },
      release: async (person, categories) => {
        rows = rows.filter(
          (row) =>
            row.person !== person ||
            row.source !== RETAINED_SOURCE ||
            row.category === null ||
            !categories.includes(row.category),
        );
      },
    },
    restrictionsOf: (person) =>
      rows
        .filter((row) => row.person === person)
        .map(({ source, category }) => ({ source, category })),
    snapshot: () => {
      const saved = { rows, positions };
      return () => {
        ({ rows, positions } = saved);
      };
    },
    rows: () => rows,
    positions: () => [...positions].map(([person, position]) => ({ person, position })),
  };
};
