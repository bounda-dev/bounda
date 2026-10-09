import type { SqlDatabase, SqlExecutor } from "@bounda-dev/core/adapter/sql";

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
