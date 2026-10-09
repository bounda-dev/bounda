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
   * Put in front of every table Bounda creates. Defaults to `bounda_`.
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
  /**
   * A file on this machine, a database in this process's memory, or a server.
   */
  readonly location: "file" | "memory" | "remote";
}

export interface ResolveSqliteOptionsFunction {
  (options: SqliteOptions): ResolvedSqliteOptions;
}

/**
 * The table prefix `sqlite()` uses when none is given.
 */
export const DEFAULT_TABLE_PREFIX: string = "bounda_";

// libSQL keeps these in the process's memory, with a single connection.
const IN_MEMORY = /^(?:file:)?:memory:(?:\?|$)/;

const locationOf = (url: string): ResolvedSqliteOptions["location"] => {
  if (IN_MEMORY.test(url)) return "memory";
  return url.startsWith("file:") ? "file" : "remote";
};

/**
 * Turns the user's options into the libSQL client configuration.
 */
export const resolveSqliteOptions: ResolveSqliteOptionsFunction = (options) => {
  const tablePrefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
  if ("memory" in options) return { url: ":memory:", tablePrefix, location: "memory" };
  if ("path" in options) return { url: `file:${options.path}`, tablePrefix, location: "file" };
  return {
    url: options.url,
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    tablePrefix,
    location: locationOf(options.url),
  };
};
