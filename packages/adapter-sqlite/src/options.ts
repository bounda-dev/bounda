/**
 * Where the database lives: a local file, memory, or a libSQL server such as Turso.
 */
export type SqliteLocation =
  | { readonly path: string }
  | { readonly url: string; readonly authToken?: string }
  | { readonly memory: true };

/**
 * Options of `sqlite(...)`: where the database is, and the prefix of Bounda's tables.
 */
export type SqliteOptions = SqliteLocation & {
  /**
   * Put in front of every table Bounda creates. Defaults to `DEFAULT_TABLE_PREFIX`.
   */
  readonly tablePrefix?: string;
};

/**
 * The libSQL client configuration `resolveSqliteOptions` makes of `SqliteOptions`.
 */
export interface ResolvedSqliteOptions {
  readonly url: string;
  readonly authToken?: string;
  readonly tablePrefix: string;
}

export interface ResolveSqliteOptionsFunction {
  (options: SqliteOptions): ResolvedSqliteOptions;
}

/**
 * The table prefix `sqlite()` uses when none is given.
 */
export const DEFAULT_TABLE_PREFIX: string = "bounda_";

/**
 * Turns the user's options into the libSQL client configuration.
 */
export const resolveSqliteOptions: ResolveSqliteOptionsFunction = (options) => {
  const tablePrefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
  if ("memory" in options) return { url: ":memory:", tablePrefix };
  if ("path" in options) return { url: `file:${options.path}`, tablePrefix };
  return {
    url: options.url,
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    tablePrefix,
  };
};
