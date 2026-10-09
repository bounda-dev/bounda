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
   * The database is in this process, a file or memory: every statement outside a transaction,
   * the driver's own included, waits its turn behind the write transactions. libSQL waits for a
   * lock by blocking the thread, so a statement that met a transaction of this same process would
   * freeze it until the busy timeout; in memory, it would fail on the one connection.
   */
  readonly local: boolean;
  /**
   * Switches a file to WAL on first use, so other processes keep reading while one writes.
   */
  readonly wal: boolean;
}

/**
 * The database the stores use, and the client queries get as `client.raw`.
 */
export interface SqliteConnection {
  readonly db: SqliteDatabase;
  readonly raw: Client;
}

export interface CreateSqliteDatabaseFunction {
  (client: Client, options: CreateSqliteDatabaseOptions): SqliteConnection;
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

const QUEUED_METHODS: ReadonlySet<PropertyKey> = new Set(["execute", "batch", "executeMultiple"]);

export const createSqliteDatabase: CreateSqliteDatabaseFunction = (client, { local, wal }) => {
  const serially = createSerialQueue();
  let ready: Promise<void> | undefined;
  const prepared = <T>(task: () => Promise<T>): Promise<T> => {
    if (ready === undefined && wal) {
      const switching = client.execute("PRAGMA journal_mode = WAL").then(() => undefined);
      ready = switching;
      // A first use that could not switch, say behind another process's long write, leaves the
      // next one to try again rather than failing every statement after it.
      switching.catch(() => {
        if (ready === switching) ready = undefined;
      });
    }
    return ready === undefined ? task() : ready.then(task);
  };
  const outside = <T>(task: () => Promise<T>): Promise<T> =>
    prepared(() => (local ? serially(task) : task()));
  const direct = executorOf(client);
  const raw = local
    ? new Proxy(client, {
        get: (target, property) => {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          const method = value.bind(target) as (...args: unknown[]) => unknown;
          return QUEUED_METHODS.has(property)
            ? (...args: unknown[]) => outside(async () => method(...args))
            : method;
        },
      })
    : client;
  return {
    raw,
    db: {
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
    },
  };
};
