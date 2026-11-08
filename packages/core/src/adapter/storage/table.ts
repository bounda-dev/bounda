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

type Comparable = string | number | Date;

// `null` (or `undefined`) matches a row without a value, so only an optional field takes it.
type Equality<Value> = undefined extends Value ? NonNullable<Value> | null | undefined : Value;

/**
 * What `where` accepts for one field: a value, matched by equality, or the operators of its type.
 * Strings, numbers and dates take a `RangeFilter`, booleans a `SetFilter`, and JSON values only a
 * value.
 */
export type FieldFilter<Value> = [NonNullable<Value>] extends [Comparable]
  ? Equality<Value> | RangeFilter<NonNullable<Value>>
  : [NonNullable<Value>] extends [boolean]
    ? Equality<Value> | SetFilter<boolean>
    : Equality<Value>;

/**
 * The rows a table call acts on: every field named must match. Strings compare as the database
 * orders them, as `orderBy` does: by code point in SQLite and in memory, by the column's collation
 * in PostgreSQL. A field the view declares as `json` matches by equality only, whatever the type of
 * its value.
 */
export type Where<Row> = { readonly [Field in keyof Row]?: FieldFilter<Row[Field]> };

export interface FindManyArgs<Row> {
  readonly where?: Where<Row>;
  readonly orderBy?: TableOrder<Row>;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A typed view over one read-model table. Every write is idempotent, so a redelivered event does
 * no harm: `upsert` replaces, `update` and `delete` are no-ops when nothing matches, `insert`
 * ignores duplicates of the primary key. A `where` naming a field the view does not have, or an
 * operator it does not know, rejects with `ConfigurationError`.
 */
export interface Table<Row> {
  upsert(row: Row): Promise<void>;
  insert(row: Row): Promise<void>;
  update(where: Where<Row>, patch: Partial<Row>): Promise<void>;
  delete(where: Where<Row>): Promise<void>;
  findOne(where: Where<Row>): Promise<Row | null>;
  findMany(args?: FindManyArgs<Row>): Promise<readonly Row[]>;
  count(where?: Where<Row>): Promise<number>;
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
