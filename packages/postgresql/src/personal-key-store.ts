import type { PersonalKeyStore } from "@bounda-dev/core/adapter";
import type { SqlExecutor } from "@bounda-dev/core/adapter/sql";

export interface CreatePostgresqlPersonalKeyStoreArgs {
  readonly db: SqlExecutor;
  readonly table: string;
}

export interface CreatePostgresqlPersonalKeyStoreFunction {
  (args: CreatePostgresqlPersonalKeyStoreArgs): PersonalKeyStore;
}

export const createPostgresqlPersonalKeyStore: CreatePostgresqlPersonalKeyStoreFunction = ({
  db,
  table,
}) => {
  const get = async (person: string): Promise<string | null> => {
    const [row] = await db.all(`SELECT "key" FROM ${table} WHERE "person" = $1`, [person]);
    return row === undefined ? null : String(row.key);
  };
  return {
    get,
    // Whichever writer inserted first, every one answers with the key in force.
    add: async (person, key) => {
      await db.run(
        `INSERT INTO ${table} ("person", "key") VALUES ($1, $2) ON CONFLICT ("person") DO NOTHING`,
        [person, key],
      );
      return (await get(person)) ?? key;
    },
    remove: async (person) =>
      (await db.all(`DELETE FROM ${table} WHERE "person" = $1 RETURNING "person"`, [person]))
        .length === 1,
  };
};
