import type { RestrictionGround } from "../../modules/personal-data.ts";
import type { FieldsRecord } from "../../modules/view.ts";
import type { Table } from "./table.ts";

/**
 * Which rows of restricted persons a read of a read model leaves out: `unrestricted` leaves out
 * every one, `retained` only those of a restriction a person asked for, so what a forgetting kept
 * under a legal obligation is read, and `all` none.
 */
export type RestrictionView = "unrestricted" | "retained" | "all";

/**
 * The source of the rows a forgetting kept under a legal obligation, beside the grounds a person
 * asks to be restricted on.
 */
export const RETAINED_SOURCE: "retained" = "retained";

/**
 * One restriction as the read side keeps it: on a ground a person asked for, or `retained`; of a
 * category or, `null`, of the person as a whole.
 */
export interface RestrictedPerson {
  readonly person: string;
  readonly source: RestrictionGround | typeof RETAINED_SOURCE;
  readonly category: string | null;
}

/**
 * The read side's copy of who is restricted, in a database that holds read models, which the
 * runtime keeps from the stream: `bounda:<personId>` says what each person asked to restrict and
 * what each forgetting kept.
 */
export interface RestrictedPersonsStore {
  /**
   * Replaces what the person asked to restrict with `restrictions`, leaving what a forgetting kept.
   */
  request(
    person: string,
    restrictions: readonly {
      readonly ground: RestrictionGround;
      readonly categories: readonly string[] | null;
    }[],
  ): Promise<void>;
  /**
   * Records the categories a forgetting kept under a legal obligation.
   */
  retain(person: string, categories: readonly string[]): Promise<void>;
  /**
   * Forgets the categories a forgetting kept, once their retention ended or they were forgotten.
   */
  release(person: string, categories: readonly string[]): Promise<void>;
}

/**
 * The reads of a read model that leave out the rows of restricted persons: those whose field
 * marked `.person()` names a person restricted as a whole, or in a category a field of the read
 * model marked `.personal()` holds. A read model without a field marked `.person()` has no row of
 * anyone's.
 */
export interface RestrictedReads<Row extends object> {
  /**
   * The read model's table, its reads leaving out the rows of every restricted person; its writes
   * are the table's.
   */
  readonly unrestricted: Table<Row>;
  /**
   * The same, leaving out only the rows of a restriction a person asked for.
   */
  readonly retained: Table<Row>;
  /**
   * Which of `persons` `view` leaves out of this read model.
   */
  among(persons: readonly string[], view: RestrictionView): Promise<ReadonlySet<string>>;
}

/**
 * The fields of a read model a restriction goes by: the one marked `.person()`, and the
 * categories of those marked `.personal()`.
 */
export interface RestrictedFields {
  readonly person: string;
  readonly categories: readonly string[];
}

export interface RestrictedFieldsOfFunction {
  (fields: FieldsRecord): RestrictedFields | null;
}

/**
 * `null` for a read model without a field marked `.person()`: none of its rows is anyone's.
 */
export const restrictedFieldsOf: RestrictedFieldsOfFunction = (fields) => {
  const entries = Object.entries(fields);
  const person = entries.find(([, field]) => field.mark === "person")?.[0];
  if (person === undefined) return null;
  const categories = new Set<string>();
  for (const [, field] of entries) {
    if (field.mark === "personal" && field.category !== null) categories.add(field.category);
  }
  return { person, categories: [...categories].sort() };
};

export interface IsLeftOutArgs {
  readonly restrictions: readonly Omit<RestrictedPerson, "person">[];
  readonly categories: readonly string[];
  readonly view: RestrictionView;
}

export interface IsLeftOutFunction {
  (args: IsLeftOutArgs): boolean;
}

/**
 * Whether a person with these restrictions has their rows left out of a read model whose personal
 * fields are in `categories`: what the SQL of each adapter says, for a store that filters itself.
 */
export const isLeftOut: IsLeftOutFunction = ({ restrictions, categories, view }) =>
  view !== "all" &&
  restrictions.some(
    ({ source, category }) =>
      (category === null || categories.includes(category)) &&
      (view === "unrestricted" || source !== RETAINED_SOURCE),
  );
