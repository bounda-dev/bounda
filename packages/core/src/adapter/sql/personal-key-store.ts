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
  const keyOf = (row: Record<string, unknown>): StoredPersonalKey => ({
    key: String(row.key),
    fingerprint: String(row.fingerprint),
    kid: row.kid === null ? null : String(row.kid),
  });
  const get = async (person: string): Promise<StoredPersonalKey | null> => {
    const [row] = await db.all(
      `SELECT "key", "fingerprint", "kid" FROM ${table} WHERE "person" = ${p(1)}`,
      [person],
    );
    return row === undefined ? null : keyOf(row);
  };
  return {
    get,
    // Whichever writer inserted first, every one answers with the key in force.
    add: async (person, key) => {
      await db.run(
        `INSERT INTO ${table} ("person", "key", "fingerprint", "kid") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}) ON CONFLICT ("person") DO NOTHING`,
        [person, key.key, key.fingerprint, key.kid],
      );
      return (await get(person)) ?? key;
    },
    remove: async (person) =>
      (await db.all(`DELETE FROM ${table} WHERE "person" = ${p(1)} RETURNING "person"`, [person]))
        .length === 1,
    // One equality per id, so the index on `kid` answers each.
    listWrappedUnder: async ({ kids, limit }) => {
      const named = kids.filter((kid) => kid !== null);
      const conditions = [
        ...named.map((_, index) => `"kid" = ${p(index + 1)}`),
        ...(named.length < kids.length ? [`"kid" IS NULL`] : []),
      ];
      if (conditions.length === 0) return [];
      const rows = await db.all(
        `SELECT "person", "key", "fingerprint", "kid" FROM ${table} WHERE ${conditions.join(" OR ")} ORDER BY "person" LIMIT ${p(named.length + 1)}`,
        [...named, limit],
      );
      return rows.map((row) => ({ person: String(row.person), key: keyOf(row) }));
    },
    rewrap: async (person, from, to) =>
      (
        await db.all(
          `UPDATE ${table} SET "key" = ${p(1)}, "kid" = ${p(2)} WHERE "person" = ${p(3)} AND "key" = ${p(4)} AND "fingerprint" = ${p(5)} RETURNING "person"`,
          [to.key, to.kid, person, from.key, from.fingerprint],
        )
      ).length === 1,
  };
};
