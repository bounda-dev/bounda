import type { PersonStore, StoredPerson } from "../storage/person-store.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface CreateSqlPersonStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlPersonStoreFunction {
  (args: CreateSqlPersonStoreArgs): PersonStore;
}

/**
 * The person store of SQLite and PostgreSQL alike, on the SQL both speak. Each write is one
 * statement that only touches a row in the other state, so two writers racing on one person
 * change it once between them.
 */
export const createSqlPersonStore: CreateSqlPersonStoreFunction = ({ db, table, dialect }) => {
  const p = dialect.placeholder;
  return {
    get: async (person) => {
      const [row] = await db.all(
        `SELECT "person", "restricted_since" FROM ${table} WHERE "person" = ${p(1)}`,
        [person],
      );
      if (row === undefined) return null;
      const since = row.restricted_since;
      return {
        person: String(row.person),
        restrictedSince: since === null ? null : String(since),
      } satisfies StoredPerson;
    },
    restrict: async (person, since) =>
      (
        await db.all(
          `INSERT INTO ${table} ("person", "restricted_since") VALUES (${p(1)}, ${p(2)}) ON CONFLICT ("person") DO UPDATE SET "restricted_since" = EXCLUDED."restricted_since" WHERE ${table}."restricted_since" IS NULL RETURNING "person"`,
          [person, since.toISOString()],
        )
      ).length === 1,
    unrestrict: async (person) =>
      (
        await db.all(
          `UPDATE ${table} SET "restricted_since" = NULL WHERE "person" = ${p(1)} AND "restricted_since" IS NOT NULL RETURNING "person"`,
          [person],
        )
      ).length === 1,
  };
};
