import type {
  HeldPersonalKey,
  PersonalKeyStore,
  StoredPersonalKey,
} from "../storage/personal-key-store.ts";
import type { SqlDialect } from "./dialect.ts";
import { holdEndOf, holdOf, releasedBy as released } from "./hold.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface CreateSqlPersonalKeyStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Both already quoted: the keys, and the persons whose restriction `listDue` reads.
   */
  readonly table: string;
  readonly persons: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlPersonalKeyStoreFunction {
  (args: CreateSqlPersonalKeyStoreArgs): PersonalKeyStore;
}

const text = (value: unknown): string | null => (value === null ? null : String(value));

const keyOf = (row: Record<string, unknown>): StoredPersonalKey => ({
  key: String(row.key),
  fingerprint: String(row.fingerprint),
  kid: row.kid === null ? null : String(row.kid),
});

const heldOf = (row: Record<string, unknown>): HeldPersonalKey => ({
  category: String(row.category),
  key: keyOf(row),
  retainedSince: text(row.retained_since),
  lastActiveAt: text(row.last_active_at),
});

const HELD = `"category", "key", "fingerprint", "kid", "retained_since", "last_active_at"`;

// The predicate of the unique index that keeps one key in force per person and category, which an
// `ON CONFLICT` on it repeats.
const IN_FORCE = `"retained_since" IS NULL`;

// The predicate of the index `listDue` reads.
const ACTIVE = `"last_active_at" IS NOT NULL`;

/**
 * The personal key store of SQLite and PostgreSQL alike, on the SQL both speak.
 */
export const createSqlPersonalKeyStore: CreateSqlPersonalKeyStoreFunction = ({
  db,
  table,
  persons,
  dialect,
}) => {
  const p = dialect.placeholder;
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
  // The row as `from` was read: `rewrap` and `hold` change it only while it holds that key.
  const holding = `"person" = ${p(3)} AND "key" = ${p(4)} AND "fingerprint" = ${p(5)}`;
  // A key whose person is restricted is left alone, so a list never fills up with such keys.
  const unrestricted = `NOT EXISTS (SELECT 1 FROM ${persons} AS "r" WHERE "r"."person" = ${table}."person" AND "r"."restricted_since" IS NOT NULL)`;
  const dueReleasedBy = (placeholder: string): string =>
    released(placeholder).replaceAll('"held_until"', '"forget_held_until"');
  const get = async (person: string, category: string): Promise<StoredPersonalKey | null> => {
    const [row] = await db.all(
      `SELECT "key", "fingerprint", "kid" FROM ${table} WHERE "person" = ${p(1)} AND "category" = ${p(2)} AND ${IN_FORCE}`,
      [person, category],
    );
    return row === undefined ? null : keyOf(row);
  };
  return {
    get,
    find: async (person, fingerprint) => {
      const [row] = await db.all(
        `SELECT ${HELD} FROM ${table} WHERE "person" = ${p(1)} AND "fingerprint" = ${p(2)}`,
        [person, fingerprint],
      );
      return row === undefined ? null : heldOf(row);
    },
    list: async (person) =>
      (
        await db.all(
          `SELECT ${HELD} FROM ${table} WHERE "person" = ${p(1)} ORDER BY "fingerprint"`,
          [person],
        )
      ).map(heldOf),
    // Whichever writer inserted first, every one answers with the key in force. A new key starts
    // from the person's last activity recorded since their last forgetting as a whole, so a key
    // made for an inactive person, as the backfill makes, still comes due.
    add: async (person, category, key) => {
      await db.run(
        `INSERT INTO ${table} ("person", "category", "key", "fingerprint", "kid", "last_active_at") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, (SELECT "last_active_at" FROM ${persons} WHERE "person" = ${p(6)} AND "forgotten_at" IS NULL)) ON CONFLICT ("person", "category") WHERE ${IN_FORCE} DO NOTHING`,
        [person, category, key.key, key.fingerprint, key.kid, person],
      );
      return (await get(person, category)) ?? key;
    },
    remove: async (person, fingerprint) =>
      (
        await db.all(
          `DELETE FROM ${table} WHERE "person" = ${p(1)} AND "fingerprint" = ${p(2)} RETURNING "person"`,
          [person, fingerprint],
        )
      ).length === 1,
    retain: async (person, fingerprint, { since, lastActiveAt }) =>
      (
        await db.all(
          `UPDATE ${table} SET "retained_since" = ${p(1)}, "last_active_at" = ${p(2)}, "forget_held_until" = NULL, "forget_attempts" = 0 WHERE "person" = ${p(3)} AND "fingerprint" = ${p(4)} AND ${IN_FORCE} RETURNING "person"`,
          [since, lastActiveAt, person, fingerprint],
        )
      ).length === 1,
    touch: async (person, lastActiveAt) => {
      await db.run(
        `UPDATE ${table} SET "last_active_at" = ${p(1)}, "forget_held_until" = NULL, "forget_attempts" = 0 WHERE "person" = ${p(2)} AND ${IN_FORCE} AND ("last_active_at" IS NULL OR "last_active_at" < ${p(3)})`,
        [lastActiveAt, person, lastActiveAt],
      );
    },
    listDue: async ({ category, activeBefore, releasedBy, limit }) => {
      const conditions = [`"category" = ${p(1)}`, ACTIVE, unrestricted];
      const values: unknown[] = [category];
      if (activeBefore !== undefined) {
        values.push(activeBefore.toISOString());
        conditions.push(`"last_active_at" <= ${p(values.length)}`);
      }
      if (releasedBy !== undefined) {
        values.push(releasedBy.toISOString());
        conditions.push(dueReleasedBy(p(values.length)));
      }
      values.push(limit);
      const rows = await db.all(
        `SELECT "person", "category", "fingerprint", "last_active_at", "retained_since", "forget_held_until", "forget_attempts" FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY "last_active_at", "person", "fingerprint" LIMIT ${p(values.length)}`,
        values,
      );
      return rows.map((row) => ({
        person: String(row.person),
        category: String(row.category),
        fingerprint: String(row.fingerprint),
        lastActiveAt: String(row.last_active_at),
        retainedSince: text(row.retained_since),
        hold: holdOf({ held_until: row.forget_held_until, attempts: row.forget_attempts }),
      }));
    },
    holdDue: async (person, fingerprint, lastActiveAt, { until, attempts }) => {
      await db.run(
        `UPDATE ${table} SET "forget_held_until" = ${p(1)}, "forget_attempts" = ${p(2)} WHERE "person" = ${p(3)} AND "fingerprint" = ${p(4)} AND "last_active_at" = ${p(5)}`,
        [until, attempts, person, fingerprint, lastActiveAt],
      );
    },
    nextDueHoldEnd: async ({ category, after }) =>
      holdEndOf(
        await db.all(
          `SELECT MIN("forget_held_until") AS "until" FROM ${table} WHERE "category" = ${p(1)} AND ${ACTIVE} AND ${unrestricted} AND "forget_held_until" > ${p(2)}`,
          [category, after.toISOString()],
        ),
      ),
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
        `SELECT "person", "category", "key", "fingerprint", "kid", "held_until", "attempts" FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY "person", "fingerprint" LIMIT ${p(values.length)}`,
        values,
      );
      return rows.map((row) => ({
        person: String(row.person),
        category: String(row.category),
        key: keyOf(row),
        hold: holdOf(row),
      }));
    },
    rewrap: async (person, from, to) =>
      (
        await db.all(
          `UPDATE ${table} SET "key" = ${p(1)}, "kid" = ${p(2)}, "held_until" = NULL, "attempts" = 0 WHERE ${holding} RETURNING "person"`,
          [to.key, to.kid, person, from.key, from.fingerprint],
        )
      ).length === 1,
    hold: async (person, from, { until, attempts }) => {
      await db.run(
        `UPDATE ${table} SET "held_until" = ${p(1)}, "attempts" = ${p(2)} WHERE ${holding}`,
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
