import type { IndexKeyStore } from "../storage/index-key-store.ts";
import type { StoredPersonalKey } from "../storage/personal-key-store.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./sql-table.ts";

// The row of the key in force, so two instances adding a key at once conflict on it, and that of
// the previous one.
const SCOPE = "app";
const PREVIOUS = "previous";

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
  const read = async (scope: string) =>
    storedOf(
      (
        await db.all(`SELECT "key", "fingerprint", "kid" FROM ${table} WHERE "scope" = ${p(1)}`, [
          scope,
        ])
      )[0],
    );
  const get = () => read(SCOPE);
  return {
    get,
    previous: () => read(PREVIOUS),
    // The previous row first, then the row in force, each a statement of its own: a supersede
    // that stopped between the two finds `from` kept already, and finishes.
    supersede: async (from, to, kept, at) => {
      const [current] = await db.all(
        `SELECT "created_at" FROM ${table} WHERE "scope" = ${p(1)} AND "fingerprint" = ${p(2)} AND "key" = ${p(3)}`,
        [SCOPE, from.fingerprint, from.key],
      );
      if (current === undefined) return false;
      await db.run(
        `INSERT INTO ${table} ("scope", "fingerprint", "key", "kid", "created_at") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}) ON CONFLICT ("scope") DO NOTHING`,
        [PREVIOUS, from.fingerprint, kept.key, kept.kid, String(current.created_at)],
      );
      if ((await read(PREVIOUS))?.fingerprint !== from.fingerprint) return false;
      return (
        (
          await db.all(
            `UPDATE ${table} SET "key" = ${p(1)}, "fingerprint" = ${p(2)}, "kid" = ${p(3)}, "created_at" = ${p(4)} WHERE "scope" = ${p(5)} AND "fingerprint" = ${p(6)} AND "key" = ${p(7)} RETURNING "scope"`,
            [to.key, to.fingerprint, to.kid, at.toISOString(), SCOPE, from.fingerprint, from.key],
          )
        ).length === 1
      );
    },
    dropPrevious: async (previous) =>
      (
        await db.all(
          `DELETE FROM ${table} WHERE "scope" = ${p(1)} AND "fingerprint" = ${p(2)} AND "key" = ${p(3)} RETURNING "scope"`,
          [PREVIOUS, previous.fingerprint, previous.key],
        )
      ).length === 1,
    add: async (key, at) => {
      await db.run(
        `INSERT INTO ${table} ("scope", "fingerprint", "key", "kid", "created_at") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}) ON CONFLICT ("scope") DO NOTHING`,
        [SCOPE, key.fingerprint, key.key, key.kid, at.toISOString()],
      );
      return (await get()) ?? key;
    },
    replace: async (from, to) =>
      (
        await db.all(
          `UPDATE ${table} SET "key" = ${p(1)}, "fingerprint" = ${p(2)}, "kid" = ${p(3)} WHERE "scope" = ${p(4)} AND "fingerprint" = ${p(5)} AND "key" = ${p(6)} RETURNING "scope"`,
          [to.key, to.fingerprint, to.kid, SCOPE, from.fingerprint, from.key],
        )
      ).length === 1,
    clear: async () => {
      await db.run(`DELETE FROM ${table} WHERE "scope" IN (${p(1)}, ${p(2)})`, [SCOPE, PREVIOUS]);
    },
    rewrap: async (from, to) =>
      (
        await db.all(
          `UPDATE ${table} SET "key" = ${p(1)}, "kid" = ${p(2)} WHERE "scope" IN (${p(3)}, ${p(4)}) AND "fingerprint" = ${p(5)} AND "key" = ${p(6)} RETURNING "scope"`,
          [to.key, to.kid, SCOPE, PREVIOUS, from.fingerprint, from.key],
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
