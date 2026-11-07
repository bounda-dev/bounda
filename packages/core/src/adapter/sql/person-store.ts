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

const COLUMNS = `"person", "restricted_since", "last_active_at", "forgotten_at"`;

// The predicate of the index the schemas create for `listIdle`, which a query must repeat for the
// index to serve it.
const IDLE = `"last_active_at" IS NOT NULL AND "forgotten_at" IS NULL AND "restricted_since" IS NULL`;

const text = (value: unknown): string | null => (value === null ? null : String(value));

const storedPerson = (row: Record<string, unknown>): StoredPerson => ({
  person: String(row.person),
  restrictedSince: text(row.restricted_since),
  lastActiveAt: text(row.last_active_at),
  forgottenAt: text(row.forgotten_at),
});

/**
 * The person store of SQLite and PostgreSQL alike, on the SQL both speak. Each restriction write
 * is one statement that only touches a row in the other state, so two writers racing on one
 * person change it once between them, and `record` only touches a row that records an earlier
 * position.
 */
export const createSqlPersonStore: CreateSqlPersonStoreFunction = ({ db, table, dialect }) => {
  const p = dialect.placeholder;
  return {
    get: async (person) => {
      const [row] = await db.all(`SELECT ${COLUMNS} FROM ${table} WHERE "person" = ${p(1)}`, [
        person,
      ]);
      return row === undefined ? null : storedPerson(row);
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
    record: async ({ person, position, lastActiveAt, forgottenAt }) => {
      await db.run(
        `INSERT INTO ${table} ("person", "position", "last_active_at", "forgotten_at") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}) ON CONFLICT ("person") DO UPDATE SET "position" = EXCLUDED."position", "last_active_at" = COALESCE(EXCLUDED."last_active_at", ${table}."last_active_at"), "forgotten_at" = EXCLUDED."forgotten_at" WHERE ${table}."position" < EXCLUDED."position"`,
        [person, position, lastActiveAt ?? null, forgottenAt],
      );
    },
    listIdle: async ({ activeBefore, limit }) => {
      const rows =
        activeBefore === undefined
          ? await db.all(
              `SELECT ${COLUMNS} FROM ${table} WHERE ${IDLE} ORDER BY "last_active_at", "person" LIMIT ${p(1)}`,
              [limit],
            )
          : await db.all(
              `SELECT ${COLUMNS} FROM ${table} WHERE ${IDLE} AND "last_active_at" <= ${p(1)} ORDER BY "last_active_at", "person" LIMIT ${p(2)}`,
              [activeBefore.toISOString(), limit],
            );
      return rows.map(storedPerson);
    },
  };
};
