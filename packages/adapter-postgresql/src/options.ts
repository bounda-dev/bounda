/**
 * How to reach the server: a connection URL or its parts.
 */
export type PostgresqlLocation =
  | { readonly url: string }
  | {
      readonly host: string;
      readonly port?: number;
      readonly database: string;
      readonly user: string;
      readonly password?: string;
      readonly ssl?: boolean;
    };

/**
 * Options of `postgresql(...)`: where the server is, and where and how Bounda keeps its tables.
 */
export type PostgresqlOptions = PostgresqlLocation & {
  /**
   * Holds every Bounda table, and is created when missing. Defaults to `DEFAULT_SCHEMA`.
   */
  readonly schema?: string;
  /**
   * Put in front of every table name. Defaults to `DEFAULT_TABLE_PREFIX`.
   */
  readonly tablePrefix?: string;
  /**
   * The size of the pool. Defaults to `DEFAULT_MAX_CONNECTIONS`.
   */
  readonly maxConnections?: number;
};

/**
 * `PostgresqlOptions` with every default filled in.
 */
export interface ResolvedPostgresqlOptions {
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  readonly ssl?: boolean;
  readonly schema: string;
  readonly tablePrefix: string;
  readonly maxConnections: number;
}

export interface ResolvePostgresqlOptionsFunction {
  (options: PostgresqlOptions): ResolvedPostgresqlOptions;
}

/**
 * The table prefix `postgresql()` uses when none is given.
 */
export const DEFAULT_TABLE_PREFIX: string = "bounda_";
/**
 * The schema `postgresql()` uses when none is given.
 */
export const DEFAULT_SCHEMA: string = "public";
/**
 * The pool size `postgresql()` uses when none is given.
 */
export const DEFAULT_MAX_CONNECTIONS: number = 10;

/**
 * Fills the defaults and drops undefined parts.
 */
export const resolvePostgresqlOptions: ResolvePostgresqlOptionsFunction = (options) => {
  const common = {
    schema: options.schema ?? DEFAULT_SCHEMA,
    tablePrefix: options.tablePrefix ?? DEFAULT_TABLE_PREFIX,
    maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
  };
  if ("url" in options) return { url: options.url, ...common };
  return {
    host: options.host,
    database: options.database,
    user: options.user,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.password === undefined ? {} : { password: options.password }),
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    ...common,
  };
};
