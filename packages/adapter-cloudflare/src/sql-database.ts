import type { SqlDatabase, SqlExecutor } from "@bounda-dev/core/adapter/sql";

/**
 * The part of a Durable Object's `ctx.storage` the adapter uses: its synchronous SQLite handle and
 * the transaction wrapper.
 */
export interface DurableSqlStorage {
  readonly sql: SqlStorage;
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

export interface CreateDurableSqlDatabaseFunction {
  (storage: DurableSqlStorage): SqlDatabase;
}

type Binding = string | number | null | ArrayBuffer;

const bindings = (params: readonly unknown[]): Binding[] =>
  params.map((value) => (typeof value === "boolean" ? Number(value) : (value as Binding)));

/**
 * Wraps a Durable Object's SQLite storage as the connection the SQLite stores write through.
 * `sql.exec` is synchronous; the executor returns resolved promises so the stores keep their
 * asynchronous interface. `write` runs the work inside `storage.transaction`, which rolls back
 * when the work throws; the transaction's `raw` is `storage.sql`, which joins it.
 */
export const createDurableSqlDatabase: CreateDurableSqlDatabaseFunction = (storage) => {
  const executor: SqlExecutor = {
    run: async (statement, params) => {
      storage.sql.exec(statement, ...bindings(params));
    },
    all: async (statement, params) =>
      storage.sql.exec<Record<string, SqlStorageValue>>(statement, ...bindings(params)).toArray(),
  };
  return {
    ...executor,
    write: (work) => storage.transaction(() => work({ ...executor, raw: storage.sql })),
  };
};
