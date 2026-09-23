import type { SqlDatabase, SqlExecutor } from "@bounda-dev/core/adapter/sql";
import type { Client, InValue, ResultSet, Transaction } from "@libsql/client";

/**
 * The libSQL client seen through the two calls the SQL helpers need, plus write transactions.
 * `write` runs the work inside `BEGIN IMMEDIATE ... COMMIT`, one write transaction at a time
 * within the process, so it never has to wait on the engine's busy handler for another
 * transaction of the same process. The transaction's `raw` is the libSQL `Transaction`.
 */
export type SqliteDatabase = SqlDatabase;

export interface CreateSqliteDatabaseFunction {
  (client: Client): SqliteDatabase;
}

const toRows = (result: ResultSet): readonly Record<string, unknown>[] =>
  result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, index) => [column, row[index] ?? null])),
  );

const executorOf = (target: Client | Transaction): SqlExecutor => ({
  run: async (sql, params) => {
    await target.execute({ sql, args: params as InValue[] });
  },
  all: async (sql, params) => toRows(await target.execute({ sql, args: params as InValue[] })),
});

const createSerialQueue = (): (<T>(task: () => Promise<T>) => Promise<T>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = tail.then(task, task);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
};

/**
 * Wraps a libSQL client. Plain statements run on the client's pool; `write` takes one write
 * transaction at a time.
 */
export const createSqliteDatabase: CreateSqliteDatabaseFunction = (client) => {
  const serially = createSerialQueue();
  return {
    ...executorOf(client),
    write: (work) =>
      serially(async () => {
        const transaction = await client.transaction("write");
        try {
          const result = await work({ ...executorOf(transaction), raw: transaction });
          await transaction.commit();
          return result;
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
      }),
  };
};
