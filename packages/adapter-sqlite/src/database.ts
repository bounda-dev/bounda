import type { SqlDatabase, SqlExecutor } from "@bounda-dev/core/adapter/sql";
import type { Client, InValue, ResultSet, Transaction } from "@libsql/client";

/**
 * The libSQL client as the SQL helpers use it, plus write transactions. `write` runs one write
 * transaction at a time within the process, so it never waits on the engine's busy handler for
 * another transaction of its own; inside it, `raw` is the libSQL `Transaction`.
 */
export type SqliteDatabase = SqlDatabase;

export interface CreateSqliteDatabaseOptions {
  /**
   * Statements run once, before anything else, on the first use.
   */
  readonly setup?: readonly string[];
  /**
   * The client has one connection, which an open transaction holds: every statement outside a
   * transaction then waits its turn behind the writes, instead of failing.
   */
  readonly singleConnection?: boolean;
}

export interface CreateSqliteDatabaseFunction {
  (client: Client, options?: CreateSqliteDatabaseOptions): SqliteDatabase;
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

export const createSqliteDatabase: CreateSqliteDatabaseFunction = (
  client,
  { setup = [], singleConnection = false } = {},
) => {
  const serially = createSerialQueue();
  let ready: Promise<void> | undefined;
  const prepared = <T>(task: () => Promise<T>): Promise<T> => {
    ready ??= (async () => {
      for (const statement of setup) await client.execute(statement);
    })();
    return ready.then(task);
  };
  const direct = executorOf(client);
  const outside = <T>(task: () => Promise<T>): Promise<T> =>
    prepared(() => (singleConnection ? serially(task) : task()));
  return {
    run: (sql, params) => outside(() => direct.run(sql, params)),
    all: (sql, params) => outside(() => direct.all(sql, params)),
    write: (work) =>
      prepared(() =>
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
      ),
  };
};
