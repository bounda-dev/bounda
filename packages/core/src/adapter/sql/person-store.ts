import type { PersonStore, StoredPerson } from "../storage/person-store.ts";
import type { SqlDialect } from "./dialect.ts";
import { holdEndOf, holdOf, releasedBy as released } from "./hold.ts";
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

const COLUMNS = `"person", "restricted_since", "last_active_at", "forgotten_at", "held_until", "attempts"`;

// The predicate of the index the schemas create for `listIdle`, which a query must repeat for the
// index to serve it.
const IDLE = `"last_active_at" IS NOT NULL AND "forgotten_at" IS NULL AND "restricted_since" IS NULL`;

// The predicate of the index for `nextHoldEnd`.
const HELD = `${IDLE} AND "held_until" IS NOT NULL`;

const text = (value: unknown): string | null => (value === null ? null : String(value));

const storedPerson = (row: Record<string, unknown>): StoredPerson => ({
  person: String(row.person),
  restrictedSince: text(row.restricted_since),
  lastActiveAt: text(row.last_active_at),
  forgottenAt: text(row.forgotten_at),
  hold: holdOf(row),
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
        `INSERT INTO ${table} ("person", "position", "last_active_at", "forgotten_at") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}) ON CONFLICT ("person") DO UPDATE SET "position" = EXCLUDED."position", "last_active_at" = COALESCE(EXCLUDED."last_active_at", ${table}."last_active_at"), "forgotten_at" = EXCLUDED."forgotten_at", "held_until" = NULL, "attempts" = 0 WHERE ${table}."position" < EXCLUDED."position"`,
        [person, position, lastActiveAt ?? null, forgottenAt],
      );
    },
    listIdle: async ({ activeBefore, releasedBy, limit }) => {
      const conditions = [IDLE];
      const values: unknown[] = [];
      if (activeBefore !== undefined) {
        values.push(activeBefore.toISOString());
        conditions.push(`"last_active_at" <= ${p(values.length)}`);
      }
      if (releasedBy !== undefined) {
        values.push(releasedBy.toISOString());
        conditions.push(released(p(values.length)));
      }
      values.push(limit);
      const rows = await db.all(
        `SELECT ${COLUMNS} FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY "last_active_at", "person" LIMIT ${p(values.length)}`,
        values,
      );
      return rows.map(storedPerson);
    },
    hold: async (person, lastActiveAt, { until, attempts }) => {
      await db.run(
        `UPDATE ${table} SET "held_until" = ${p(1)}, "attempts" = ${p(2)} WHERE "person" = ${p(3)} AND "last_active_at" = ${p(4)} AND "forgotten_at" IS NULL`,
        [until, attempts, person, lastActiveAt],
      );
    },
    nextHoldEnd: async (after) =>
      holdEndOf(
        await db.all(
          `SELECT MIN("held_until") AS "until" FROM ${table} WHERE ${HELD} AND "held_until" > ${p(1)}`,
          [after.toISOString()],
        ),
      ),
  };
};
