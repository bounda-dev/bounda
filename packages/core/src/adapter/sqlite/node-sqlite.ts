/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Adapter } from "../adapter.ts";
import type { SqlDatabase } from "../sql/database.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";
import { createSqliteAdapter } from "./adapter.ts";

const bind = (params: readonly unknown[]): SQLInputValue[] =>
  params.map((value) => (typeof value === "boolean" ? Number(value) : value)) as SQLInputValue[];

export interface NodeSqliteAdapter {
  readonly adapter: Adapter;
  readonly db: DatabaseSync;
  /**
   * How many write transactions were opened so far.
   */
  transactions(): number;
}

export interface CreateNodeSqliteAdapterFunction {
  (path?: string): NodeSqliteAdapter;
}

/**
 * The shared SQLite adapter on Node's own SQLite, for kernel tests and measurements on a real
 * single-writer store: one connection, `BEGIN IMMEDIATE` per write transaction, WAL when on disk.
 */
export const createNodeSqliteAdapter: CreateNodeSqliteAdapterFunction = (path = ":memory:") => {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
  let opened = 0;
  const executor: SqlExecutor = {
    run: async (sql, params) => {
      db.prepare(sql).run(...bind(params));
    },
    all: async (sql, params) => db.prepare(sql).all(...bind(params)) as Record<string, unknown>[],
  };
  let queue: Promise<unknown> = Promise.resolve();
  const database: SqlDatabase = {
    ...executor,
    write: (work) => {
      const next = queue.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        opened += 1;
        try {
          const result = await work({ ...executor, raw: db });
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
  const adapter = createSqliteAdapter({
    name: "node-sqlite",
    options: { path },
    tablePrefix: "bounda_",
    acquire: () => ({ db: database, raw: db }),
    release: async () => {},
  });
  return { adapter, db, transactions: () => opened };
};
