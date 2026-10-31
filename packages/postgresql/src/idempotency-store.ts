import { IdempotencyKeyTakenError } from "@bounda-dev/core";
import type {
  DispatchOutcome,
  IdempotencyRecord,
  IdempotencyStore,
  KeyedPerson,
} from "@bounda-dev/core/adapter";
import { postgresqlDialect } from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";
import { heldKeys, naming } from "./held-keys.ts";

export interface CreatePostgresqlIdempotencyStoreArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
  // The personal keys a record's persons must hold for `put` to write it.
  readonly personalKeys: string;
}

export interface CreatePostgresqlIdempotencyStoreFunction {
  (args: CreatePostgresqlIdempotencyStoreArgs): IdempotencyStore;
}

const toRecord = (row: Record<string, unknown>): IdempotencyRecord => ({
  key: String(row.key),
  fingerprint: String(row.fingerprint),
  outcome: row.outcome as DispatchOutcome,
  expiresAt: String(row.expires_at),
  persons: row.persons as KeyedPerson[],
});

/**
 * `put` is a single upsert: PostgreSQL locks the conflicting row, so of two dispatches racing for
 * one key exactly one gets its row back. It locks the keys of the persons the record names too,
 * as a snapshot's `put` does, so a forget beside it waits and then removes it, or removed a key
 * first and leaves it nothing to record, even once the person has another key; no row back with
 * no live record under the key is that.
 */
export const createPostgresqlIdempotencyStore: CreatePostgresqlIdempotencyStoreFunction = ({
  db,
  table,
  personalKeys,
}) => {
  const get: IdempotencyStore["get"] = async ({ key, now }) => {
    const [row] = await db.all(
      `SELECT "key", "fingerprint", "outcome", "expires_at", "persons" FROM ${table} WHERE "key" = $1 AND "expires_at" > $2`,
      [key, now.toISOString()],
    );
    return row === undefined ? null : toRecord(row);
  };
  return {
    get,
    put: async ({ key, fingerprint, outcome, expiresAt, now, persons }) => {
      const rows = await db.all(
        `INSERT INTO ${table} ("key", "fingerprint", "outcome", "expires_at", "persons")
       SELECT $1, $2, $3, $4, $6::jsonb WHERE ${heldKeys({ personalKeys, persons: "$6" })}
       ON CONFLICT ("key") DO UPDATE SET
         "fingerprint" = excluded."fingerprint",
         "outcome" = excluded."outcome",
         "expires_at" = excluded."expires_at",
         "persons" = excluded."persons"
       WHERE ${table}."expires_at" <= $5
       RETURNING "key"`,
        [
          key,
          fingerprint,
          postgresqlDialect.encode("json", outcome),
          expiresAt,
          now.toISOString(),
          postgresqlDialect.encode("json", persons),
        ],
      );
      if (rows.length === 0 && (await get({ key, now })) !== null) {
        throw new IdempotencyKeyTakenError(key);
      }
    },
    purge: async ({ now }) => {
      const rows = await db.all(`DELETE FROM ${table} WHERE "expires_at" <= $1 RETURNING "key"`, [
        now.toISOString(),
      ]);
      return rows.length;
    },
    forget: (person) => db.run(`DELETE FROM ${table} WHERE ${naming("$1")}`, [person]),
  };
};
