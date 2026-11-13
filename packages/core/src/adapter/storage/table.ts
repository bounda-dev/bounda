import type { FieldAccess } from "../../modules/view.ts";

/**
 * How `findMany` sorts: by a field that is not sealed at rest.
 */
export interface TableOrder<Row, Types extends FieldTypes<Row> = FieldTypesOfRow<Row>> {
  readonly field: OrderableField<Row, Types>;
  readonly direction: "asc" | "desc";
}

/**
 * The fields a table sorts by: every one but those sealed at rest.
 */
export type OrderableField<Row, Types extends FieldTypes<Row> = FieldTypesOfRow<Row>> = {
  [Field in keyof Row]-?: Types[Field] extends "sealed" | "lookup" ? never : Field;
}[keyof Row] &
  string;

/**
 * The fields sealed at rest that have a blind index, which `where` matches by equality and
 * `ReadClient.blindIndex` computes for hand-written SQL.
 */
export type LookupField<Row, Types extends FieldTypes<Row> = FieldTypesOfRow<Row>> = {
  [Field in keyof Row]-?: Types[Field] extends "lookup" ? Field : never;
}[keyof Row] &
  string;

/**
 * What a field that has an order can be filtered by, besides a value: above (`gt`, `gte`), below
 * (`lt`, `lte`), not equal (`ne`) or one of (`in`). Operators on one field all hold. An operand
 * left `undefined` adds no condition, but one of them must have a value. A range leaves out rows
 * without a value; `ne` keeps them, and `ne: null` keeps only the rows with one. `in: []` matches
 * nothing.
 */
export interface RangeFilter<Value> {
  readonly gt?: Value | undefined;
  readonly gte?: Value | undefined;
  readonly lt?: Value | undefined;
  readonly lte?: Value | undefined;
  readonly ne?: Value | null | undefined;
  readonly in?: readonly Value[] | undefined;
}

/**
 * What a boolean field can be filtered by, besides a value: it has no order to range over.
 */
export type SetFilter<Value> = Pick<RangeFilter<Value>, "ne" | "in">;

// `null` (or `undefined`) matches a row without a value, so only an optional field takes it.
type Equality<Value> = undefined extends Value ? NonNullable<Value> | null | undefined : Value;

/**
 * How each field of a row is stored, as its view declares it with `f.string()`, `f.json()` and the
 * rest, or sealed at rest, as `.personal()` marks it. It decides what `where` takes for the field.
 */
export type FieldTypes<Row> = { readonly [Field in keyof Row]-?: FieldAccess };

type Comparable = string | number | Date;

type ComparableAs<Value> = Value extends string
  ? "string"
  : Value extends number
    ? "number"
    : Value extends Date
      ? "date"
      : never;

// A union of strings, numbers and dates keeps its ranges; one with anything else is JSON.
type StoredAs<Value> = [Value] extends [Comparable]
  ? ComparableAs<Value>
  : [Value] extends [boolean]
    ? "boolean"
    : "json";

/**
 * The field types a row's values imply, for a table typed without its view: strings, numbers,
 * dates and booleans as such, any other value as JSON.
 */
export type FieldTypesOfRow<Row> = {
  readonly [Field in keyof Row]-?: StoredAs<NonNullable<Row[Field]>>;
};

/**
 * What `where` accepts for one field: a value, matched by equality, or the operators of how it is
 * stored. Strings, numbers and dates take a `RangeFilter`, booleans a `SetFilter`, and JSON only a
 * value, whatever its type. A field sealed at rest takes nothing, unless it has a blind index:
 * then a value or a `SetFilter`, matched through the index; `null` matches a row without a value,
 * or whose value was forgotten.
 */
export type FieldFilter<
  Value,
  Type extends FieldAccess = StoredAs<NonNullable<Value>>,
> = Type extends "sealed"
  ? never
  : Type extends "json"
    ? Equality<Value>
    : Type extends "boolean" | "lookup"
      ? Equality<Value> | SetFilter<NonNullable<Value>>
      : Equality<Value> | RangeFilter<NonNullable<Value>>;

/**
 * The rows a table call acts on: every field named must match. Strings compare by code point, as
 * `orderBy` sorts them, on every database. A field the view declares as `json` matches by
 * equality only, so an object there is the value to match, not operators.
 */
export type Where<Row, Types extends FieldTypes<Row> = FieldTypesOfRow<Row>> = {
  readonly [Field in keyof Row]?: FieldFilter<Row[Field], Types[Field]>;
};

export interface FindManyArgs<Row, Types extends FieldTypes<Row> = FieldTypesOfRow<Row>> {
  readonly where?: Where<Row, Types>;
  readonly orderBy?: TableOrder<Row, Types>;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A typed view over one read-model table. Every write is idempotent, so a redelivered event does
 * no harm: `upsert` replaces, `update` and `delete` are no-ops when nothing matches, `insert`
 * ignores duplicates of the primary key. Rows are ordered as SQLite orders them on every
 * database: strings by code point, rows without a value first going up and last going down. A
 * `where` naming a field the view does not have, an operator it does not know, or a range on a
 * boolean, rejects with `ConfigurationError`, as does a `where` or an `orderBy` a sealed field
 * cannot take. `Types` is how the view stores each field; without it, the values' types stand in.
 */
export interface Table<Row, Types extends FieldTypes<Row> = FieldTypesOfRow<Row>> {
  upsert(row: Row): Promise<void>;
  insert(row: Row): Promise<void>;
  update(where: Where<Row, Types>, patch: Partial<Row>): Promise<void>;
  delete(where: Where<Row, Types>): Promise<void>;
  findOne(where: Where<Row, Types>): Promise<Row | null>;
  findMany(args?: FindManyArgs<Row, Types>): Promise<readonly Row[]>;
  count(where?: Where<Row, Types>): Promise<number>;
}

/**
 * The client of a read model as its adapter gives it: `get` and `all` run SQL against its storage
 * and decode the rows as stored, `raw` exposes the underlying driver.
 */
export interface StoredReadClient<Row, Raw = unknown> {
  get(sql: string, params?: readonly unknown[]): Promise<Row | null>;
  all(sql: string, params?: readonly unknown[]): Promise<readonly Row[]>;
  readonly raw: Raw;
}

/**
 * The client a query's `repository` and a projection receive. `get` and `all` run SQL against the
 * read model's storage and type the rows from the view definition, with the fields sealed at rest
 * opened. `raw` exposes the underlying driver, which reads those fields as ciphertext and never
 * opens them. A sealed field matches in SQL only through its blind index column, named after the
 * field's column with `__index` (`email_address__index` for `emailAddress`), compared to what
 * `blindIndex` computes.
 */
export interface ReadClient<
  Row,
  Raw = unknown,
  Types extends FieldTypes<Row> = FieldTypesOfRow<Row>,
> extends StoredReadClient<Row, Raw> {
  /**
   * The blind index of `value` in `field`, a field sealed at rest with `.index()` or `.unique()`:
   * what its index column holds for a row whose field has that value, so `WHERE email__index = ?`
   * finds it. Throws `ConfigurationError` for a field without one.
   */
  blindIndex<Field extends LookupField<Row, Types>>(
    field: Field,
    value: NonNullable<Row[Field]>,
  ): Promise<string>;
}
