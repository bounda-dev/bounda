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
    listByPerson: async ({ person, now }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE ${naming("$1")} AND "expires_at" > $2 ORDER BY "key"`,
          [person, now.toISOString()],
        )
      ).map(toRecord),
    reseal: async ({ key, answer, persons, now }) =>
      (
        await db.all(
          `UPDATE ${table} SET "outcome" = $1::jsonb, "persons" = $2::jsonb WHERE "key" = $3 AND "expires_at" > $4 AND "outcome" <> 'null'::jsonb RETURNING "key"`,
          [
            postgresqlDialect.encode("json", answer),
            postgresqlDialect.encode("json", persons),
            key,
            now.toISOString(),
          ],
        )
      ).length > 0,
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
