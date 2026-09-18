/**
 * Ordering for `Table.findMany`.
 */
export interface TableOrder<Row> {
  readonly field: keyof Row & string;
  readonly direction: "asc" | "desc";
}

/**
 * Arguments for `Table.findMany`.
 */
export interface FindManyArgs<Row> {
  readonly where?: Partial<Row>;
  readonly orderBy?: TableOrder<Row>;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A typed view over one read-model table. Projections write through it and queries may read
 * through it. Every write is idempotent by construction so a redelivered event does no harm:
 * `upsert` replaces, `update` and `delete` are no-ops when nothing matches, `insert` ignores
 * duplicates of the primary key.
 */
export interface Table<Row> {
  upsert(row: Row): Promise<void>;
  insert(row: Row): Promise<void>;
  update(where: Partial<Row>, patch: Partial<Row>): Promise<void>;
  delete(where: Partial<Row>): Promise<void>;
  findOne(where: Partial<Row>): Promise<Row | null>;
  findMany(args?: FindManyArgs<Row>): Promise<readonly Row[]>;
  count(where?: Partial<Row>): Promise<number>;
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
