import { DEFAULT_TABLE_PREFIX } from "@bounda-dev/core/adapter/sql";

export type SqliteLocation =
  | {
      readonly path: string;
      /**
       * Whether an app with a key wrapper and a tenant key store encrypts the file under a key of
       * its tenant's own, which forgetting the tenant destroys with the file's every copy. Defaults
       * to `true`; without them, the file stays in the clear.
       */
      readonly encrypt?: boolean;
    }
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

export interface ResolvedSqliteOptions {
  readonly url: string;
  readonly authToken?: string;
  readonly tablePrefix: string;
  readonly location: "file" | "memory" | "remote";
}

export interface ResolveSqliteOptionsFunction {
  (options: SqliteOptions): ResolvedSqliteOptions;
}

// libSQL keeps these in the process's memory, with a single connection.
const IN_MEMORY = /^(?:file:)?:memory:(?:\?|$)/;

const locationOf = (url: string): ResolvedSqliteOptions["location"] => {
  if (IN_MEMORY.test(url)) return "memory";
  return url.startsWith("file:") ? "file" : "remote";
};

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
