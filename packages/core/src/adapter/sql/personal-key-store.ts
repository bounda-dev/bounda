import type {
  DueKey,
  HeldPersonalKey,
  PersonalKeyStore,
  StoredPersonalKey,
} from "../storage/personal-key-store.ts";
import type { SqlDialect } from "./dialect.ts";
import { holdEndOf, holdOf, releasedBy as released } from "./hold.ts";
import { byteOrder } from "./order.ts";
import { WHOLE_PERSON } from "./person-store.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface CreateSqlPersonalKeyStoreArgs {
  readonly db: SqlExecutor;
  /**
   * All already quoted: the keys, the persons whose last activity a new key starts from, and the
   * restrictions the sweeps leave alone.
   */
  readonly table: string;
  readonly persons: string;
  readonly restrictions: string;
  /**
   * Already quoted: the keys a reseal superseded.
   */
  readonly superseded: string;
  readonly dialect: Pick<SqlDialect, "placeholder" | "name">;
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

// A superseded key `"s"` as `find` hands it out: with the category, retention and activity of the
// key `"k"` in its place.
const SUPERSEDED = `"k"."category", "s"."key", "s"."fingerprint", "s"."kid", "k"."retained_since", "k"."last_active_at", "k"."fingerprint" AS "successor"`;

const supersededOf = (row: Record<string, unknown>): HeldPersonalKey => ({
  ...heldOf(row),
  successor: String(row.successor),
});

// Within the hundred parameters a Durable Object's SQLite binds to one statement.
const PERSONS_PER_STATEMENT = 90;

// The predicate of the unique index that keeps one key in force per person and category, which an
// `ON CONFLICT` on it repeats.
const IN_FORCE = `"retained_since" IS NULL`;

// The predicate of the index `listDue` reads.
const ACTIVE = `"last_active_at" IS NOT NULL`;

// The predicate of the index `listRetained` reads.
const RETAINED = `"retained_since" IS NOT NULL`;

const DUE = `"person", "category", "fingerprint", "last_active_at", "retained_since", "forget_held_until", "forget_attempts"`;

const dueOf = (row: Record<string, unknown>): DueKey => ({
  person: String(row.person),
  category: String(row.category),
  fingerprint: String(row.fingerprint),
  lastActiveAt: String(row.last_active_at),
  retainedSince: text(row.retained_since),
  hold: holdOf({ held_until: row.forget_held_until, attempts: row.forget_attempts }),
});

/**
 * The personal key store of SQLite and PostgreSQL alike, on the SQL both speak.
 */
export const createSqlPersonalKeyStore: CreateSqlPersonalKeyStoreFunction = ({
  db,
  table,
  persons,
  restrictions,
  superseded,
  dialect,
}) => {
  const p = dialect.placeholder;
  const byCode = byteOrder(dialect);
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
  // A key whose category is restricted, or whose person is as a whole, is left alone, so a list
  // never fills up with such keys.
  const unrestricted = `NOT EXISTS (SELECT 1 FROM ${restrictions} AS "r" WHERE "r"."person" = ${table}."person" AND "r"."category" IN ('${WHOLE_PERSON}', ${table}."category"))`;
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
    // A superseded key reads with the one that took its place, while both are kept.
    find: async (person, fingerprint) => {
      const [row] = await db.all(
        `SELECT ${HELD} FROM ${table} WHERE "person" = ${p(1)} AND "fingerprint" = ${p(2)}`,
        [person, fingerprint],
      );
      if (row !== undefined) return heldOf(row);
      const [old] = await db.all(
        `SELECT ${SUPERSEDED} FROM ${superseded} AS "s" JOIN ${table} AS "k" ON "k"."person" = "s"."person" AND "k"."fingerprint" = "s"."successor" WHERE "s"."person" = ${p(1)} AND "s"."fingerprint" = ${p(2)} AND "s"."key" IS NOT NULL`,
        [person, fingerprint],
      );
      return old === undefined ? null : supersededOf(old);
    },
    list: async (person) =>
      (
        await db.all(
          `SELECT ${HELD} FROM ${table} WHERE "person" = ${p(1)} ORDER BY "fingerprint"`,
          [person],
        )
      ).map(heldOf),
    listMany: async (persons) => {
      const listed = new Map<string, HeldPersonalKey[]>();
      const distinct = [...new Set(persons)];
      for (let start = 0; start < distinct.length; start += PERSONS_PER_STATEMENT) {
        const chunk = distinct.slice(start, start + PERSONS_PER_STATEMENT);
        const rows = await db.all(
          `SELECT "person", ${HELD} FROM ${table} WHERE "person" IN (${chunk.map((_, index) => p(index + 1)).join(", ")}) ORDER BY "person", "fingerprint"`,
          chunk,
        );
        for (const row of rows) {
          const person = String(row.person);
          listed.set(person, [...(listed.get(person) ?? []), heldOf(row)]);
        }
        const old = await db.all(
          `SELECT "s"."person", ${SUPERSEDED} FROM ${superseded} AS "s" JOIN ${table} AS "k" ON "k"."person" = "s"."person" AND "k"."fingerprint" = "s"."successor" WHERE "s"."person" IN (${chunk.map((_, index) => p(index + 1)).join(", ")}) AND "s"."key" IS NOT NULL ORDER BY "s"."person", "s"."fingerprint"`,
          chunk,
        );
        for (const row of old) {
          const person = String(row.person);
          listed.set(person, [...(listed.get(person) ?? []), supersededOf(row)]);
        }
      }
      return listed;
    },
    persons: async ({ after, limit }) =>
      (
        await db.all(
          after === undefined
            ? `SELECT "person" FROM ${table} GROUP BY "person" ORDER BY "person"${byCode} LIMIT ${p(1)}`
            : `SELECT "person" FROM ${table} WHERE "person"${byCode} > ${p(1)} GROUP BY "person" ORDER BY "person"${byCode} LIMIT ${p(2)}`,
          after === undefined ? [limit] : [after, limit],
        )
      ).map((row) => String(row.person)),
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
    kids: async () =>
      (
        await db.all(
          `SELECT "kid" FROM ${table} UNION SELECT "kid" FROM ${superseded} WHERE "key" IS NOT NULL`,
          [],
        )
      ).map(({ kid }) => (kid === null ? null : String(kid))),
    categories: async () =>
      (await db.all(`SELECT DISTINCT "category" FROM ${table} ORDER BY "category"`, [])).map(
        ({ category }) => String(category),
      ),
    clear: async () => {
      await db.run(`DELETE FROM ${superseded}`, []);
      return (await db.all(`DELETE FROM ${table} RETURNING "person"`, [])).length;
    },
    // What the key superseded goes with it: it opens what the key does.
    remove: async (person, fingerprint) => {
      await db.run(`DELETE FROM ${superseded} WHERE "person" = ${p(1)} AND "successor" = ${p(2)}`, [
        person,
        fingerprint,
      ]);
      return (
        (
          await db.all(
            `DELETE FROM ${table} WHERE "person" = ${p(1)} AND "fingerprint" = ${p(2)} RETURNING "person"`,
            [person, fingerprint],
          )
        ).length === 1
      );
    },
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
        `SELECT ${DUE} FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY "last_active_at", "person", "fingerprint" LIMIT ${p(values.length)}`,
        values,
      );
      return rows.map(dueOf);
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
    // A key a forgetting retained has its activity frozen, so `last_active_at` is never null.
    listRetained: async ({ except, releasedBy, limit }) => {
      const conditions = [RETAINED, unrestricted];
      const values: unknown[] = [];
      if (except.length > 0) {
        conditions.push(`"category" NOT IN (${except.map((_, index) => p(index + 1)).join(", ")})`);
        values.push(...except);
      }
      if (releasedBy !== undefined) {
        values.push(releasedBy.toISOString());
        conditions.push(dueReleasedBy(p(values.length)));
      }
      values.push(limit);
      const rows = await db.all(
        `SELECT ${DUE} FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY "retained_since", "person", "fingerprint" LIMIT ${p(values.length)}`,
        values,
      );
      return rows.map(dueOf);
    },
    nextRetainedHoldEnd: async ({ except, after }) => {
      const values: unknown[] = [...except, after.toISOString()];
      const outside =
        except.length === 0
          ? ""
          : ` AND "category" NOT IN (${except.map((_, index) => p(index + 1)).join(", ")})`;
      return holdEndOf(
        await db.all(
          `SELECT MIN("forget_held_until") AS "until" FROM ${table} WHERE ${RETAINED}${outside} AND ${unrestricted} AND "forget_held_until" > ${p(values.length)}`,
          values,
        ),
      );
    },
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
    countWrappedUnder: async ({ kids }) => {
      const under = wrappedUnder(kids);
      if (under === null) return 0;
      const [row] = await db.all(
        `SELECT count(*) AS "count" FROM ${table} WHERE ${under.condition}`,
        under.values,
      );
      return Number(row?.count ?? 0);
    },
    // The key's place, its retention, activity and the hold of its retention pass to the new key;
    // the rotation's hold does not, since the new key is wrapped under the version in force. Keys
    // the old one superseded follow it, so each superseded key names the key in its place now.
    supersede: async (person, from, to) => {
      const [old] = await db.all(
        `DELETE FROM ${table} WHERE "person" = ${p(1)} AND "key" = ${p(2)} AND "fingerprint" = ${p(3)} RETURNING "category", "last_active_at", "retained_since", "forget_held_until", "forget_attempts"`,
        [person, from.key, from.fingerprint],
      );
      if (old === undefined) return false;
      await db.run(
        `INSERT INTO ${table} ("person", "category", "key", "fingerprint", "kid", "last_active_at", "retained_since", "forget_held_until", "forget_attempts") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)})`,
        [
          person,
          old.category,
          to.key,
          to.fingerprint,
          to.kid,
          old.last_active_at,
          old.retained_since,
          old.forget_held_until,
          old.forget_attempts,
        ],
      );
      await db.run(
        `UPDATE ${superseded} SET "successor" = ${p(1)} WHERE "person" = ${p(2)} AND "successor" = ${p(3)}`,
        [to.fingerprint, person, from.fingerprint],
      );
      await db.run(
        `INSERT INTO ${superseded} ("person", "fingerprint", "successor", "key", "kid", "superseded_at") VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)})`,
        [person, from.fingerprint, to.fingerprint, from.key, from.kid, to.at],
      );
      return true;
    },
    predecessors: async (person, fingerprints) =>
      fingerprints.length === 0
        ? []
        : (
            await db.all(
              `SELECT "fingerprint" FROM ${superseded} WHERE "person" = ${p(1)} AND "successor" IN (${fingerprints.map((_, index) => p(index + 2)).join(", ")}) ORDER BY "fingerprint"`,
              [person, ...fingerprints],
            )
          ).map(({ fingerprint }) => String(fingerprint)),
    countSuperseded: async () => {
      const [row] = await db.all(
        `SELECT count(*) AS "count" FROM ${superseded} WHERE "key" IS NOT NULL`,
        [],
      );
      return Number(row?.count ?? 0);
    },
    destroySuperseded: async () =>
      (
        await db.all(
          `UPDATE ${superseded} SET "key" = NULL, "kid" = NULL WHERE "key" IS NOT NULL RETURNING "person"`,
          [],
        )
      ).length,
    releaseHolds: async () =>
      (
        await db.all(
          `UPDATE ${table} SET "held_until" = NULL, "attempts" = 0 WHERE "held_until" IS NOT NULL RETURNING "person"`,
          [],
        )
      ).length,
    countDue: async ({ category, activeBefore }) => {
      const conditions = [`"category" = ${p(1)}`, ACTIVE, unrestricted];
      const values: unknown[] = [category];
      if (activeBefore !== undefined) {
        values.push(activeBefore.toISOString());
        conditions.push(`"last_active_at" <= ${p(values.length)}`);
      }
      const [row] = await db.all(
        `SELECT count(*) AS "count" FROM ${table} WHERE ${conditions.join(" AND ")}`,
        values,
      );
      return Number(row?.count ?? 0);
    },
    countRetained: async ({ except }) => {
      const outside =
        except.length === 0
          ? ""
          : ` AND "category" NOT IN (${except.map((_, index) => p(index + 1)).join(", ")})`;
      const [row] = await db.all(
        `SELECT count(*) AS "count" FROM ${table} WHERE ${RETAINED}${outside} AND ${unrestricted}`,
        [...except],
      );
      return Number(row?.count ?? 0);
    },
    releaseDueHolds: async () =>
      (
        await db.all(
          `UPDATE ${table} SET "forget_held_until" = NULL, "forget_attempts" = 0 WHERE "forget_held_until" IS NOT NULL RETURNING "person"`,
          [],
        )
      ).length,
  };
};

export interface SupersededKeysTableStatementsFunction {
  (table: string): readonly string[];
}

// Migration 10 of the storage tables, on both engines: the keys a reseal superseded, `key` and
// `kid` emptied once destroyed.
export const supersededKeysTableStatements: SupersededKeysTableStatementsFunction = (table) => [
  `CREATE TABLE IF NOT EXISTS ${table} (
    "person" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "successor" TEXT NOT NULL,
    "key" TEXT,
    "kid" TEXT,
    "superseded_at" TEXT NOT NULL,
    PRIMARY KEY ("person", "fingerprint")
  )`,
  `CREATE INDEX IF NOT EXISTS "${table.slice(1, -1)}_successor_idx" ON ${table} ("person", "successor")`,
];
