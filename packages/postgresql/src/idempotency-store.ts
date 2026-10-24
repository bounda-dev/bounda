import { IdempotencyKeyTakenError } from "@bounda-dev/core";
import type {
  DispatchOutcome,
  IdempotencyRecord,
  IdempotencyStore,
} from "@bounda-dev/core/adapter";
import { postgresqlDialect } from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";

export interface CreatePostgresqlIdempotencyStoreArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
}

export interface CreatePostgresqlIdempotencyStoreFunction {
  (args: CreatePostgresqlIdempotencyStoreArgs): IdempotencyStore;
}

const toRecord = (row: Record<string, unknown>): IdempotencyRecord => ({
  key: String(row.key),
  fingerprint: String(row.fingerprint),
  outcome: row.outcome as DispatchOutcome,
  expiresAt: String(row.expires_at),
});

/**
 * `put` is a single upsert: PostgreSQL locks the conflicting row, so of two dispatches racing for
 * one key exactly one gets its row back.
 */
export const createPostgresqlIdempotencyStore: CreatePostgresqlIdempotencyStoreFunction = ({
  db,
  table,
}) => ({
  get: async ({ key, now }) => {
    const [row] = await db.all(
      `SELECT "key", "fingerprint", "outcome", "expires_at" FROM ${table} WHERE "key" = $1 AND "expires_at" > $2`,
      [key, now.toISOString()],
    );
    return row === undefined ? null : toRecord(row);
  },
  put: async ({ key, fingerprint, outcome, expiresAt, now }) => {
    const rows = await db.all(
      `INSERT INTO ${table} ("key", "fingerprint", "outcome", "expires_at") VALUES ($1, $2, $3, $4)
       ON CONFLICT ("key") DO UPDATE SET
         "fingerprint" = excluded."fingerprint",
         "outcome" = excluded."outcome",
         "expires_at" = excluded."expires_at"
       WHERE ${table}."expires_at" <= $5
       RETURNING "key"`,
      [key, fingerprint, postgresqlDialect.encode("json", outcome), expiresAt, now.toISOString()],
    );
    if (rows.length === 0) throw new IdempotencyKeyTakenError(key);
  },
  purge: async ({ now }) => {
    const rows = await db.all(`DELETE FROM ${table} WHERE "expires_at" <= $1 RETURNING "key"`, [
      now.toISOString(),
    ]);
    return rows.length;
  },
});
