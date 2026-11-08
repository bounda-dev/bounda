import type { PersonalKeyStore, StoredPersonalKey } from "../storage/personal-key-store.ts";
import type { SqlDialect } from "./dialect.ts";
import { holdEndOf, holdOf, releasedBy as released } from "./hold.ts";
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
  // One equality per id, so the index on `kid` answers each.
  const wrappedUnder = (
    kids: readonly (string | null)[],
  ): { readonly condition: string; readonly values: readonly string[] } | null => {
    const named = kids.filter((kid) => kid !== null);
    const conditions = [
      ...named.map((_, index) => `"kid" = ${p(index + 1)}`),
      ...(named.length < kids.length ? [`"kid" IS NULL`] : []),
    ];
    return conditions.length === 0 ? null : { condition: conditions.join(" OR "), values: named };
  };
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
    listWrappedUnder: async ({ kids, releasedBy, limit }) => {
      const under = wrappedUnder(kids);
      if (under === null) return [];
      const conditions = [`(${under.condition})`];
      const values: unknown[] = [...under.values];
      if (releasedBy !== undefined) {
        values.push(releasedBy.toISOString());
        conditions.push(released(p(values.length)));
      }
      values.push(limit);
      const rows = await db.all(
        `SELECT "person", "key", "fingerprint", "kid", "held_until", "attempts" FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY "person" LIMIT ${p(values.length)}`,
        values,
      );
      return rows.map((row) => ({
        person: String(row.person),
        key: keyOf(row),
        hold: holdOf(row),
      }));
    },
    rewrap: async (person, from, to) =>
      (
        await db.all(
          `UPDATE ${table} SET "key" = ${p(1)}, "kid" = ${p(2)}, "held_until" = NULL, "attempts" = 0 WHERE "person" = ${p(3)} AND "key" = ${p(4)} AND "fingerprint" = ${p(5)} RETURNING "person"`,
          [to.key, to.kid, person, from.key, from.fingerprint],
        )
      ).length === 1,
    hold: async (person, from, { until, attempts }) => {
      await db.run(
        `UPDATE ${table} SET "held_until" = ${p(1)}, "attempts" = ${p(2)} WHERE "person" = ${p(3)} AND "key" = ${p(4)} AND "fingerprint" = ${p(5)}`,
        [until, attempts, person, from.key, from.fingerprint],
      );
    },
    // The index on held keys answers it; few are held, so filtering them by id costs little.
    nextHoldEnd: async ({ kids, after }) => {
      const under = wrappedUnder(kids);
      if (under === null) return null;
      return holdEndOf(
        await db.all(
          `SELECT MIN("held_until") AS "until" FROM ${table} WHERE (${under.condition}) AND "held_until" > ${p(under.values.length + 1)}`,
          [...under.values, after.toISOString()],
        ),
      );
    },
  };
};
