import type { RestrictionGround } from "../../modules/personal-data.ts";
import type { PersonStore, StoredPerson, StoredRestriction } from "../storage/person-store.ts";
import type { SqlDialect } from "./dialect.ts";
import { holdEndOf, holdOf, releasedBy as released } from "./hold.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface CreateSqlPersonStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Both already quoted.
   */
  readonly table: string;
  readonly restrictions: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlPersonStoreFunction {
  (args: CreateSqlPersonStoreArgs): PersonStore;
}

const COLUMNS = `"person", "restricted_since", "last_active_at", "position", "forgotten_at", "held_until", "attempts"`;

// The predicate of the index the schemas create for `listIdle`, which a query must repeat for the
// index to serve it.
const IDLE = `"last_active_at" IS NOT NULL AND "forgotten_at" IS NULL AND "restricted_since" IS NULL`;

// The predicate of the index for `nextHoldEnd`.
const HELD = `${IDLE} AND "held_until" IS NOT NULL`;

const text = (value: unknown): string | null => (value === null ? null : String(value));

// The category of a restriction of the person as a whole, kept as text so the primary key holds it.
export const WHOLE_PERSON = "";

const storedRestriction = (row: Record<string, unknown>): StoredRestriction => ({
  ground: String(row.ground) as RestrictionGround,
  category: row.category === WHOLE_PERSON ? null : String(row.category),
  since: String(row.since),
});

const storedPerson = (row: Record<string, unknown>): StoredPerson => ({
  person: String(row.person),
  restrictedSince: text(row.restricted_since),
  lastActiveAt: text(row.last_active_at),
  position: Number(row.position),
  forgottenAt: text(row.forgotten_at),
  hold: holdOf(row),
});

/**
 * The person store of SQLite and PostgreSQL alike, on the SQL both speak. A restriction row is
 * added with `ON CONFLICT DO NOTHING` and removed by one `DELETE`, so two writers racing on one
 * person change it once between them, and `record` only touches a row that records an earlier
 * position.
 */
export const createSqlPersonStore: CreateSqlPersonStoreFunction = ({
  db,
  table,
  restrictions,
  dialect,
}) => {
  const p = dialect.placeholder;
  // Each placeholder its own value: SQLite's are positional.
  const oldest = (index: number): string =>
    `(SELECT MIN("since") FROM ${restrictions} WHERE "person" = ${p(index)})`;
  const added = async (
    person: string,
    ground: string,
    category: string,
    since: string,
  ): Promise<boolean> =>
    (
      await db.all(
        `INSERT INTO ${restrictions} ("person", "ground", "category", "since") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}) ON CONFLICT ("person", "ground", "category") DO NOTHING RETURNING "person"`,
        [person, ground, category, since],
      )
    ).length === 1;
  return {
    get: async (person) => {
      const [row] = await db.all(`SELECT ${COLUMNS} FROM ${table} WHERE "person" = ${p(1)}`, [
        person,
      ]);
      return row === undefined ? null : storedPerson(row);
    },
    restrictions: async (person) =>
      (
        await db.all(
          `SELECT "ground", "category", "since" FROM ${restrictions} WHERE "person" = ${p(1)} ORDER BY "since", "ground", "category"`,
          [person],
        )
      ).map(storedRestriction),
    restrict: async (person, { ground, categories, since }) => {
      const at = since.toISOString();
      let changed = false;
      if (categories === null) {
        changed = await added(person, ground, WHOLE_PERSON, at);
        if (changed) {
          await db.run(
            `DELETE FROM ${restrictions} WHERE "person" = ${p(1)} AND "ground" = ${p(2)} AND "category" <> ${p(3)}`,
            [person, ground, WHOLE_PERSON],
          );
        }
      } else {
        const [whole] = await db.all(
          `SELECT "person" FROM ${restrictions} WHERE "person" = ${p(1)} AND "ground" = ${p(2)} AND "category" = ${p(3)}`,
          [person, ground, WHOLE_PERSON],
        );
        if (whole !== undefined) return false;
        for (const category of categories) {
          if (await added(person, ground, category, at)) changed = true;
        }
      }
      if (changed) {
        await db.run(
          `INSERT INTO ${table} ("person", "restricted_since") VALUES (${p(1)}, ${oldest(2)}) ON CONFLICT ("person") DO UPDATE SET "restricted_since" = EXCLUDED."restricted_since"`,
          [person, person],
        );
      }
      return changed;
    },
    unrestrict: async (person, { ground, categories }) => {
      const conditions = [`"person" = ${p(1)}`];
      const values: unknown[] = [person];
      if (ground !== undefined) {
        values.push(ground);
        conditions.push(`"ground" = ${p(values.length)}`);
      }
      if (categories !== null) {
        if (categories.length === 0) return [];
        conditions.push(
          `"category" IN (${categories.map((category) => {
            values.push(category);
            return p(values.length);
          })})`,
        );
      }
      const removed = await db.all(
        `DELETE FROM ${restrictions} WHERE ${conditions.join(" AND ")} RETURNING "ground"`,
        values,
      );
      if (removed.length === 0) return [];
      await db.run(
        `UPDATE ${table} SET "restricted_since" = ${oldest(1)} WHERE "person" = ${p(2)}`,
        [person, person],
      );
      return [...new Set(removed.map((row) => String(row.ground) as RestrictionGround))].sort();
    },
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
    countIdle: async ({ activeBefore }) => {
      const [row] = await db.all(
        `SELECT count(*) AS "count" FROM ${table} WHERE ${IDLE}${activeBefore === undefined ? "" : ` AND "last_active_at" <= ${p(1)}`}`,
        activeBefore === undefined ? [] : [activeBefore.toISOString()],
      );
      return Number(row?.count ?? 0);
    },
    releaseHolds: async () =>
      (
        await db.all(
          `UPDATE ${table} SET "held_until" = NULL, "attempts" = 0 WHERE "held_until" IS NOT NULL RETURNING "person"`,
          [],
        )
      ).length,
  };
};
