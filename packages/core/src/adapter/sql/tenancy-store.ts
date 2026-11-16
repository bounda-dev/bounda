import type { Tenancy, TenancyStore } from "../storage/tenancy-store.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./sql-table.ts";

// The one row's key, so two instances binding at once conflict on it.
const SCOPE = "app";

export interface TenancyTableStatementFunction {
  (table: string): string;
}

// Migration 7 of the storage tables, on both engines.
export const tenancyTableStatement: TenancyTableStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "scope" TEXT NOT NULL PRIMARY KEY,
    "tenant" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "bound_at" TEXT NOT NULL,
    "forgotten_at" TEXT
  )`;

export interface CreateSqlTenancyStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlTenancyStoreFunction {
  (args: CreateSqlTenancyStoreArgs): TenancyStore;
}

const tenancyOf = (row: Readonly<Record<string, unknown>> | undefined): Tenancy | null =>
  row === undefined
    ? null
    : {
        tenant: String(row.tenant),
        store: String(row.store),
        boundAt: String(row.bound_at),
        forgottenAt:
          row.forgotten_at === null || row.forgotten_at === undefined
            ? null
            : String(row.forgotten_at),
      };

/**
 * `TenancyStore` on the SQL SQLite and PostgreSQL both speak.
 */
export const createSqlTenancyStore: CreateSqlTenancyStoreFunction = ({ db, table, dialect }) => {
  const p = dialect.placeholder;
  const get = async (): Promise<Tenancy | null> =>
    tenancyOf(
      (
        await db.all(
          `SELECT "tenant", "store", "bound_at", "forgotten_at" FROM ${table} WHERE "scope" = ${p(1)}`,
          [SCOPE],
        )
      )[0],
    );
  return {
    get,
    bind: async ({ tenant, store, boundAt }) => {
      await db.run(
        `INSERT INTO ${table} ("scope", "tenant", "store", "bound_at") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}) ON CONFLICT ("scope") DO NOTHING`,
        [SCOPE, tenant, store, boundAt],
      );
      return (await get()) ?? { tenant, store, boundAt, forgottenAt: null };
    },
    forget: async (at) => {
      await db.run(
        `UPDATE ${table} SET "forgotten_at" = ${p(1)} WHERE "scope" = ${p(2)} AND "forgotten_at" IS NULL`,
        [at, SCOPE],
      );
    },
  };
};
