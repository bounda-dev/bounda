/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Adapter } from "../adapter.ts";
import type { SqlDatabase } from "../sql/database.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";
import { createSqliteAdapter } from "./adapter.ts";
import { SQLITE_BUSY_TIMEOUT_MS, switchToWal } from "./wal.ts";

// node:sqlite reports a busy database as an error whose `errcode` is SQLite's own code.
const SQLITE_BUSY = 5;

const isBusy = (error: unknown): boolean =>
  error instanceof Error &&
  "errcode" in error &&
  typeof error.errcode === "number" &&
  // An extended code, such as SQLITE_BUSY_RECOVERY, keeps the primary one in its low byte.
  error.errcode % 256 === SQLITE_BUSY;

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
  const db = new DatabaseSync(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  const ready =
    path === ":memory:"
      ? Promise.resolve()
      : switchToWal({ execute: async (sql) => db.exec(sql), isBusy });
  // Rejects, when the switch fails, through every statement awaiting it; never unhandled.
  ready.catch(() => undefined);
  let opened = 0;
  const executor: SqlExecutor = {
    run: async (sql, params) => {
      db.prepare(sql).run(...bind(params));
    },
    all: async (sql, params) => db.prepare(sql).all(...bind(params)) as Record<string, unknown>[],
  };
  let queue: Promise<unknown> = ready;
  const database: SqlDatabase = {
    run: (sql, params) => ready.then(() => executor.run(sql, params)),
    all: (sql, params) => ready.then(() => executor.all(sql, params)),
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
