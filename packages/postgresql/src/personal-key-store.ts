import type { PersonalKeyStore, StoredPersonalKey } from "@bounda-dev/core/adapter";
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
  const get = async (person: string): Promise<StoredPersonalKey | null> => {
    const [row] = await db.all(`SELECT "key", "fingerprint" FROM ${table} WHERE "person" = $1`, [
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
        `INSERT INTO ${table} ("person", "key", "fingerprint") VALUES ($1, $2, $3) ON CONFLICT ("person") DO NOTHING`,
        [person, key.key, key.fingerprint],
      );
      return (await get(person)) ?? key;
    },
    remove: async (person) =>
      (await db.all(`DELETE FROM ${table} WHERE "person" = $1 RETURNING "person"`, [person]))
        .length === 1,
  };
};
