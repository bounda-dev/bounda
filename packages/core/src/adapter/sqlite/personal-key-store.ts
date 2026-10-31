import type { SqlExecutor } from "../sql/sql-table.ts";
import type { PersonalKeyStore, StoredPersonalKey } from "../storage/personal-key-store.ts";

export interface CreateSqlitePersonalKeyStoreArgs {
  readonly db: SqlExecutor;
  readonly table: string;
}

export interface CreateSqlitePersonalKeyStoreFunction {
  (args: CreateSqlitePersonalKeyStoreArgs): PersonalKeyStore;
}

export const createSqlitePersonalKeyStore: CreateSqlitePersonalKeyStoreFunction = ({
  db,
  table,
}) => {
  const get = async (person: string): Promise<StoredPersonalKey | null> => {
    const [row] = await db.all(`SELECT "key", "fingerprint" FROM ${table} WHERE "person" = ?`, [
      person,
    ]);
    return row === undefined
      ? null
      : { key: String(row.key), fingerprint: String(row.fingerprint) };
  };
  return {
    get,
    // Whichever writer inserted first, every one answers with the key in force.
    add: async (person, key) => {
      await db.run(
        `INSERT INTO ${table} ("person", "key", "fingerprint") VALUES (?, ?, ?) ON CONFLICT ("person") DO NOTHING`,
        [person, key.key, key.fingerprint],
      );
      return (await get(person)) ?? key;
    },
    remove: async (person) =>
      (await db.all(`DELETE FROM ${table} WHERE "person" = ? RETURNING "person"`, [person]))
        .length === 1,
  };
};
