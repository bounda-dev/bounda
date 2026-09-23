import type { SqlExecutor, SqlTransaction } from "@bounda-dev/core/adapter/sql";
import type { ParameterOrJSON, Sql, TransactionSql } from "postgres";

/**
 * The Postgres.js client seen through the two calls the SQL helpers need, plus transactions.
 */
export interface PostgresqlDatabase extends SqlExecutor {
  /**
   * Runs `work` inside one transaction on one pooled connection; a throw rolls it back. The
   * transaction's `raw` is the Postgres.js `TransactionSql`.
   */
  write<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T>;
}

export interface CreatePostgresqlDatabaseFunction {
  (sql: Sql): PostgresqlDatabase;
}

const executorOf = (target: Sql | TransactionSql): SqlExecutor => ({
  run: async (statement, params) => {
    await target.unsafe(statement, params as ParameterOrJSON<never>[]);
  },
  all: async (statement, params) =>
    (await target.unsafe(statement, params as ParameterOrJSON<never>[])) as unknown as Record<
      string,
      unknown
    >[],
});

/**
 * Wraps a Postgres.js client. Parameters travel with `$n` placeholders and the driver's own type
 * inference, so JSON columns take plain values and `timestamptz` columns take `Date`s.
 */
export const createPostgresqlDatabase: CreatePostgresqlDatabaseFunction = (sql) => ({
  ...executorOf(sql),
  write: (work) => sql.begin((tx) => work({ ...executorOf(tx), raw: tx })) as Promise<never>,
});
