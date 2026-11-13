import type { RestrictionGround } from "../../modules/personal-data.ts";
import type { FieldsRecord } from "../../modules/view.ts";
import { RETAINED_KEY_PREFIX, storedPersonalFields } from "./sealed-fields.ts";
import type { Table } from "./table.ts";

/**
 * Which rows of restricted persons a read of a read model leaves out: `unrestricted` leaves out
 * every one, `retained` only those of a restriction a person asked for, so what a forgetting kept
 * under a legal obligation is read, and `all` none.
 */
export type RestrictionView = "unrestricted" | "retained" | "all";

/**
 * One restriction a person asked for, as the read side keeps it: on a ground, of a category or,
 * `null`, of the person as a whole. What a forgetting kept under a legal obligation is not here:
 * each row says it, in the key fields of its personal values.
 */
export interface RestrictedPerson {
  readonly person: string;
  readonly source: RestrictionGround;
  readonly category: string | null;
}

/**
 * The read side's copy of who is restricted, in a database that holds read models, which the
 * runtime keeps from the stream: `bounda:<personId>` says what each person asked to restrict.
 */
export interface RestrictedPersonsStore {
  /**
   * Moves the person to the event at `position`, `false` when a later one was written already,
   * in this transaction or one committed before it, even one running beside it: the copy only goes
   * forward, so a subscriber reading the stream again from an earlier point, under a new name or
   * after a reset, never takes back a later change. The same event again is written again, which
   * changes nothing.
   */
  advance(person: string, position: number): Promise<boolean>;
  /**
   * Replaces what the person asked to restrict with `restrictions`.
   */
  request(
    person: string,
    restrictions: readonly {
      readonly ground: RestrictionGround;
      readonly categories: readonly string[] | null;
    }[],
  ): Promise<void>;
}

/**
 * The reads of a read model that leave out the rows of restricted persons: those whose field
 * marked `.person()` names a person restricted as a whole, or in a category a field of the read
 * model marked `.personal()` holds, and, for `unrestricted`, those holding a value under a key a
 * forgetting kept under a legal obligation, as its key field says. A read model without a field
 * marked `.person()` has no row of anyone's.
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
   * Which of `persons` a restriction they asked for leaves out of this read model, whatever their
   * rows hold: none for `all`.
   */
  among(persons: readonly string[], view: RestrictionView): Promise<ReadonlySet<string>>;
}

/**
 * The fields of a read model a restriction goes by: the one marked `.person()`, the categories of
 * those marked `.personal()`, and the key fields beside them, present in the fields given.
 */
export interface RestrictedFields {
  readonly person: string;
  readonly categories: readonly string[];
  readonly keyFields: readonly string[];
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
  const keyFields = storedPersonalFields(fields)
    .map(({ keyField }) => keyField)
    .filter((keyField) => fields[keyField] !== undefined);
  return { person, categories: [...categories].sort(), keyFields };
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
  restrictions.some(({ category }) => category === null || categories.includes(category));

export interface IsRetainedKeyFunction {
  (key: unknown): boolean;
}

/**
 * Whether a key field names a key a forgetting kept under a legal obligation.
 */
export const isRetainedKey: IsRetainedKeyFunction = (key) =>
  typeof key === "string" && key.startsWith(RETAINED_KEY_PREFIX);
