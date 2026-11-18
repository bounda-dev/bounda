import { IdempotencyKeyTakenError } from "@bounda-dev/core";
import type {
  IdempotencyRecord,
  IdempotencyStore,
  KeyedPerson,
  StoredAnswer,
} from "@bounda-dev/core/adapter";
import { postgresqlDialect } from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";
import { heldKeys, naming, outsideKept } from "./held-keys.ts";

export interface CreatePostgresqlIdempotencyStoreArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
  // The personal keys a record's persons must hold for `put` to keep its answer.
  readonly personalKeys: string;
}

export interface CreatePostgresqlIdempotencyStoreFunction {
  (args: CreatePostgresqlIdempotencyStoreArgs): IdempotencyStore;
}

const COLUMNS = `"key", "outcome", "expires_at", "persons"`;

// The column keeps its name from before answers were sealed; an erased answer is JSON `null`.
const toRecord = (row: Record<string, unknown>): IdempotencyRecord => ({
  key: String(row.key),
  answer: row.outcome as StoredAnswer | null,
  expiresAt: String(row.expires_at),
  persons: row.persons as KeyedPerson[],
});

/**
 * `put` is a single upsert: PostgreSQL locks the conflicting row, so of two dispatches racing for
 * one key exactly one gets its row back. It locks the keys of the persons the record names too,
 * as a snapshot's `put` does, so a forget beside it waits and then erases the answer, or removed a
 * key first and leaves the answer erased, even once the person has another key.
 */
export const createPostgresqlIdempotencyStore: CreatePostgresqlIdempotencyStoreFunction = ({
  db,
  table,
  personalKeys,
}) => {
  const get: IdempotencyStore["get"] = async ({ key, now }) => {
    const [row] = await db.all(
      `SELECT ${COLUMNS} FROM ${table} WHERE "key" = $1 AND "expires_at" > $2`,
      [key, now.toISOString()],
    );
    return row === undefined ? null : toRecord(row);
  };
  return {
    get,
    put: async ({ key, answer, expiresAt, now, persons }) => {
      const rows = await db.all(
        `INSERT INTO ${table} (${COLUMNS})
       SELECT $1, CASE WHEN "held" THEN $2::jsonb ELSE 'null'::jsonb END, $3, CASE WHEN "held" THEN $5::jsonb ELSE '[]'::jsonb END
       FROM (SELECT ${heldKeys({ personalKeys, persons: "$5" })} AS "held") AS "check"
       ON CONFLICT ("key") DO UPDATE SET
         "outcome" = excluded."outcome",
         "expires_at" = excluded."expires_at",
         "persons" = excluded."persons"
       WHERE ${table}."expires_at" <= $4
       RETURNING "key"`,
        [
          key,
          postgresqlDialect.encode("json", answer),
          expiresAt,
          now.toISOString(),
          postgresqlDialect.encode("json", persons),
        ],
      );
      if (rows.length === 0) throw new IdempotencyKeyTakenError(key);
    },
    listByPerson: async ({ person, now, after, limit }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE ${naming("$1")} AND "expires_at" > $2 AND ($3::text IS NULL OR "key" COLLATE "C" > $3::text) ORDER BY "key" COLLATE "C" LIMIT $4`,
          [person, now.toISOString(), after ?? null, limit ?? null],
        )
      ).map(toRecord),
    list: async ({ now, after, limit, offset = 0 }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE "expires_at" > $1 AND ($4::text IS NULL OR "key" COLLATE "C" > $4::text) ORDER BY "key" COLLATE "C" LIMIT $2 OFFSET $3`,
          [now.toISOString(), limit ?? null, offset, after ?? null],
        )
      ).map(toRecord),
    // Filing it elsewhere copies it there erased before it leaves `key`: a crash between the two
    // leaves both, and erasing it again moves it once more.
    erase: async ({ key, filed = key, now }) => {
      if (filed === key) {
        await db.run(
          `UPDATE ${table} SET "outcome" = 'null'::jsonb, "persons" = '[]'::jsonb WHERE "key" = $1 AND "expires_at" > $2`,
          [key, now.toISOString()],
        );
        return;
      }
      await db.run(
        `INSERT INTO ${table} (${COLUMNS}) SELECT $1, 'null'::jsonb, "expires_at", '[]'::jsonb FROM ${table} WHERE "key" = $2 AND "expires_at" > $3
       ON CONFLICT ("key") DO UPDATE SET "outcome" = 'null'::jsonb, "expires_at" = excluded."expires_at", "persons" = '[]'::jsonb WHERE ${table}."expires_at" <= $3`,
        [filed, key, now.toISOString()],
      );
      await db.run(`DELETE FROM ${table} WHERE "key" = $1 AND "expires_at" > $2`, [
        key,
        now.toISOString(),
      ]);
    },
    reseal: ({ key, from, answer, persons, now }) =>
      db.run(
        `UPDATE ${table} SET "outcome" = $1::jsonb, "persons" = $2::jsonb WHERE "key" = $3 AND "outcome" = $4::jsonb AND "expires_at" > $5`,
        [
          postgresqlDialect.encode("json", answer),
          postgresqlDialect.encode("json", persons),
          key,
          postgresqlDialect.encode("json", from),
          now.toISOString(),
        ],
      ),
    clear: () => db.run(`DELETE FROM ${table}`, []),
    purge: async ({ now }) => {
      const rows = await db.all(`DELETE FROM ${table} WHERE "expires_at" <= $1 RETURNING "key"`, [
        now.toISOString(),
      ]);
      return rows.length;
    },
    forget: (person, keep = []) =>
      db.run(
        `UPDATE ${table} SET "outcome" = 'null'::jsonb, "persons" = '[]'::jsonb WHERE ${naming("$1")} AND ${outsideKept({ person: "$1", keep: "$2" })}`,
        [person, postgresqlDialect.encode("json", keep)],
      ),
  };
};
