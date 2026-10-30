import type { SqlExecutor } from "../sql/sql-table.ts";
import type { PersonalKeyStore } from "../storage/personal-key-store.ts";

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
  const get = async (person: string): Promise<string | null> => {
    const [row] = await db.all(`SELECT "key" FROM ${table} WHERE "person" = ?`, [person]);
    return row === undefined ? null : String(row.key);
  };
  return {
    get,
    // Whichever writer inserted first, every one answers with the key in force.
    add: async (person, key) => {
      await db.run(
        `INSERT INTO ${table} ("person", "key") VALUES (?, ?) ON CONFLICT ("person") DO NOTHING`,
        [person, key],
      );
      return (await get(person)) ?? key;
    },
    remove: async (person) =>
      (await db.all(`DELETE FROM ${table} WHERE "person" = ? RETURNING "person"`, [person]))
        .length === 1,
  };
};
