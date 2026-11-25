import type { SqlExecutor, SqlFragment, SqlTransaction } from "@bounda-dev/core/adapter/sql";
import type { ParameterOrJSON, Sql, TransactionSql } from "postgres";

export interface PostgresqlDatabase extends SqlExecutor {
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

// Each run of statements without parameters as one, which the driver sends in a single round trip
// as a simple query; a statement with parameters as it is.
const groupedWithoutParameters = (statements: readonly SqlFragment[]): readonly SqlFragment[] => {
  const groups: SqlFragment[] = [];
  for (const statement of statements) {
    const last = groups.at(-1);
    if (statement.params.length === 0 && last !== undefined && last.params.length === 0) {
      groups[groups.length - 1] = { sql: `${last.sql};\n${statement.sql}`, params: [] };
    } else {
      groups.push(statement);
    }
  }
  return groups;
};

/**
 * Parameters go through the driver's own type inference: `timestamptz` columns take `Date`s, and
 * JSON goes through `postgresqlDialect.encode`, which keeps the driver from typing it as anything
 * but `jsonb`.
 */
export const createPostgresqlDatabase: CreatePostgresqlDatabaseFunction = (sql) => ({
  ...executorOf(sql),
  write: (work) =>
    sql.begin((tx) =>
      work({
        ...executorOf(tx),
        raw: tx,
        batch: async (statements) => {
          for (const group of groupedWithoutParameters(statements)) {
            await tx.unsafe(group.sql, group.params as ParameterOrJSON<never>[]);
          }
        },
      }),
    ) as Promise<never>,
});
