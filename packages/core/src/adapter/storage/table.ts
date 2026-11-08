import type { FieldType } from "../../modules/view.ts";

export interface TableOrder<Row> {
  readonly field: keyof Row & string;
  readonly direction: "asc" | "desc";
}

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
 * rest. It decides what `where` takes for the field.
 */
export type FieldTypes<Row> = { readonly [Field in keyof Row]-?: FieldType };

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
 * value, whatever its type.
 */
export type FieldFilter<
  Value,
  Type extends FieldType = StoredAs<NonNullable<Value>>,
> = Type extends "json"
  ? Equality<Value>
  : Type extends "boolean"
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
  readonly orderBy?: TableOrder<Row>;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A typed view over one read-model table. Every write is idempotent, so a redelivered event does
 * no harm: `upsert` replaces, `update` and `delete` are no-ops when nothing matches, `insert`
 * ignores duplicates of the primary key. Rows are ordered as SQLite orders them on every
 * database: strings by code point, rows without a value first going up and last going down. A
 * `where` naming a field the view does not have, an operator it does not know, or a range on a
 * boolean, rejects with `ConfigurationError`. `Types` is how the view stores each field; without it, the values'
 * types stand in.
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
 * The client a query's `repository` receives. `get` and `all` run SQL against the read model's
 * storage and type the rows from the view definition. `raw` exposes the underlying driver.
 */
export interface ReadClient<Row, Raw = unknown> {
  get(sql: string, params?: readonly unknown[]): Promise<Row | null>;
  all(sql: string, params?: readonly unknown[]): Promise<readonly Row[]>;
  readonly raw: Raw;
}
