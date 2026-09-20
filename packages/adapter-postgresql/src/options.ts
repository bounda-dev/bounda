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
 * Options of `postgresql(...)`. `schema` holds every Bounda table (default `public`),
 * `tablePrefix` goes in front of each table name (default `bounda_`), `maxConnections` sizes the
 * pool (default 10).
 */
export type PostgresqlOptions = PostgresqlLocation & {
  readonly schema?: string;
  readonly tablePrefix?: string;
  readonly maxConnections?: number;
};

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

export const DEFAULT_TABLE_PREFIX: string = "bounda_";
export const DEFAULT_SCHEMA: string = "public";
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
