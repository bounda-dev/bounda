import {
  fenceError,
  nextFence,
  type TenantFence,
  type TenantFenceStore,
} from "../storage/tenant-fence.ts";
import type { SqlDatabase, SqlTransaction } from "./database.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./sql-table.ts";

// The one row's key of a database, which fences one tenant.
const APP = "app";

export interface TenantFenceTableStatementFunction {
  (table: string): string;
}

/**
 * The fence's table, `table` already quoted: no row while the database is open.
 */
export const tenantFenceTableStatement: TenantFenceTableStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "scope" TEXT NOT NULL PRIMARY KEY,
    "tenant" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "since" TEXT NOT NULL
  )`;

/**
 * The fence of one SQL database, and what puts its writes behind it.
 */
export interface SqlTenantFence {
  /**
   * Rejects as the fence refuses a write, run first in the write's own transaction: every fence
   * but an open one, and a forgotten one only without `pass`.
   */
  check(tx: SqlExecutor, pass?: "forgotten"): Promise<void>;
  store(db: SqlDatabase): TenantFenceStore;
  /**
   * `db` with every write behind the fence: `write` checks it first, and a statement run outside
   * one runs in a transaction of its own that checks it, but a read, which goes as it is.
   */
  guard(db: SqlDatabase, pass?: "forgotten"): SqlDatabase;
}

export interface CreateSqlTenantFenceArgs {
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
  /**
   * The two texts hashed into the advisory lock a write holds shared and a change of the fence
   * exclusive, for an engine whose transactions run side by side, as PostgreSQL's do: a write takes
   * it before any other lock, so the fence waits for the writes under way and the writes after it
   * read it raised. Left out for an engine with one writer at a time, as SQLite.
   */
  readonly lock?: readonly [string, string];
  /**
   * The row's key, for a table that fences several stores, as a forget ledger's does, one per
   * tenant.
   */
  readonly scope?: string;
}

export interface CreateSqlTenantFenceFunction {
  (args: CreateSqlTenantFenceArgs): SqlTenantFence;
}

// What leaves the data as it is: a read, or a pragma, which sets the connection or reads the schema.
const READ = /^\s*(?:SELECT|PRAGMA)\b/i;

/**
 * The fence of a SQL database: a row of `table`, which every write of the database `guard` hands
 * out checks first in its own transaction, so a write either commits before the fence is raised or
 * is refused after it with `TenantFrozenError` or `TenantForgottenError`, writing nothing, and a
 * read goes as it is. What an adapter of your own on SQLite or PostgreSQL puts its stores behind.
 */
export const createSqlTenantFence: CreateSqlTenantFenceFunction = ({
  table,
  dialect,
  lock,
  scope = APP,
}) => {
  const p = dialect.placeholder;
  const read = async (executor: SqlExecutor): Promise<TenantFence> => {
    const [row] = await executor.all(
      `SELECT "tenant", "state", "since" FROM ${table} WHERE "scope" = ${p(1)}`,
      [scope],
    );
    if (row === undefined) return { state: "open" };
    return {
      state: row.state === "forgotten" ? "forgotten" : "frozen",
      tenant: String(row.tenant),
      since: String(row.since),
    };
  };
  const check = async (tx: SqlExecutor, pass?: "forgotten"): Promise<void> => {
    if (lock !== undefined) {
      await tx.run("SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))", [...lock]);
    }
    const fence = await read(tx);
    if (fence.state !== "open" && fence.state !== pass) throw fenceError(fence);
  };
  return {
    check,
    store: (db) => ({
      read: () => read(db),
      set: (asked) =>
        db.write(async (tx) => {
          if (lock !== undefined) {
            await tx.run("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [...lock]);
          }
          const current = await read(tx);
          const next = nextFence(current, asked);
          if (next === current) return current;
          if (next.state === "open") {
            await tx.run(`DELETE FROM ${table} WHERE "scope" = ${p(1)}`, [scope]);
          } else {
            await tx.run(
              `INSERT INTO ${table} ("scope", "tenant", "state", "since") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}) ON CONFLICT ("scope") DO UPDATE SET "tenant" = excluded."tenant", "state" = excluded."state", "since" = excluded."since"`,
              [scope, next.tenant, next.state, next.since],
            );
          }
          return next;
        }),
    }),
    guard: (db, pass) => {
      // Each awaits its statement, so a statement that fails rejects a promise awaited already, as
      // a Durable Object's runtime needs to take it for handled.
      const write = <T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T> =>
        db.write(async (tx) => {
          await check(tx, pass);
          return await work(tx);
        });
      // One statement on its own: a read as it is, any other in a transaction that checks first.
      const alone = async <T>(
        statement: string,
        work: (executor: SqlExecutor) => Promise<T>,
      ): Promise<T> => (READ.test(statement) ? await work(db) : await write(work));
      return {
        write,
        run: (statement, params) => alone(statement, (executor) => executor.run(statement, params)),
        all: (statement, params) => alone(statement, (executor) => executor.all(statement, params)),
      };
    },
  };
};
