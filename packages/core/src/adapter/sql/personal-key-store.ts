import type { PersonalKeyStore, StoredPersonalKey } from "../storage/personal-key-store.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface CreateSqlPersonalKeyStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlPersonalKeyStoreFunction {
  (args: CreateSqlPersonalKeyStoreArgs): PersonalKeyStore;
}

/**
 * The personal key store of SQLite and PostgreSQL alike, on the SQL both speak.
 */
export const createSqlPersonalKeyStore: CreateSqlPersonalKeyStoreFunction = ({
  db,
  table,
  dialect,
}) => {
  const p = dialect.placeholder;
  const get = async (person: string): Promise<StoredPersonalKey | null> => {
    const [row] = await db.all(
      `SELECT "key", "fingerprint" FROM ${table} WHERE "person" = ${p(1)}`,
      [person],
    );
    return row === undefined
      ? null
      : { key: String(row.key), fingerprint: String(row.fingerprint) };
  };
  return {
    get,
    // Whichever writer inserted first, every one answers with the key in force.
    add: async (person, key) => {
      await db.run(
        `INSERT INTO ${table} ("person", "key", "fingerprint") VALUES (${p(1)}, ${p(2)}, ${p(3)}) ON CONFLICT ("person") DO NOTHING`,
        [person, key.key, key.fingerprint],
      );
      return (await get(person)) ?? key;
    },
    remove: async (person) =>
      (await db.all(`DELETE FROM ${table} WHERE "person" = ${p(1)} RETURNING "person"`, [person]))
        .length === 1,
  };
};
