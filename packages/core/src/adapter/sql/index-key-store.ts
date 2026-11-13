import type { IndexKeyStore } from "../storage/index-key-store.ts";
import type { StoredPersonalKey } from "../storage/personal-key-store.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./sql-table.ts";

// The one row's key, so two instances adding a key at once conflict on it.
const SCOPE = "app";

export interface CreateSqlIndexKeyStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlIndexKeyStoreFunction {
  (args: CreateSqlIndexKeyStoreArgs): IndexKeyStore;
}

const storedOf = (row: Readonly<Record<string, unknown>> | undefined): StoredPersonalKey | null =>
  row === undefined
    ? null
    : {
        key: String(row.key),
        fingerprint: String(row.fingerprint),
        kid: row.kid === null || row.kid === undefined ? null : String(row.kid),
      };

/**
 * `IndexKeyStore` on the SQL SQLite and PostgreSQL both speak.
 */
export const createSqlIndexKeyStore: CreateSqlIndexKeyStoreFunction = ({ db, table, dialect }) => {
  const p = dialect.placeholder;
  const get = async () =>
    storedOf(
      (
        await db.all(`SELECT "key", "fingerprint", "kid" FROM ${table} WHERE "scope" = ${p(1)}`, [
          SCOPE,
        ])
      )[0],
    );
  return {
    get,
    add: async (key, at) => {
      await db.run(
        `INSERT INTO ${table} ("scope", "fingerprint", "key", "kid", "created_at") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}) ON CONFLICT ("scope") DO NOTHING`,
        [SCOPE, key.fingerprint, key.key, key.kid, at.toISOString()],
      );
      return (await get()) ?? key;
    },
    rewrap: async (from, to) =>
      (
        await db.all(
          `UPDATE ${table} SET "key" = ${p(1)}, "kid" = ${p(2)} WHERE "scope" = ${p(3)} AND "fingerprint" = ${p(4)} AND "key" = ${p(5)} RETURNING "scope"`,
          [to.key, to.kid, SCOPE, from.fingerprint, from.key],
        )
      ).length === 1,
  };
};

export interface IndexKeysTableStatementFunction {
  (table: string): string;
}

// Migration 5 of the storage tables, on both engines.
export const indexKeysTableStatement: IndexKeysTableStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "scope" TEXT NOT NULL PRIMARY KEY,
    "fingerprint" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kid" TEXT,
    "created_at" TEXT NOT NULL
  )`;
