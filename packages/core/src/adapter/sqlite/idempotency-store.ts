import { IdempotencyKeyTakenError } from "../../contracts/errors.ts";
import type { DispatchOutcome, IdempotencyRecord, IdempotencyStore } from "../index.ts";
import type { SqlDatabase } from "../sql/database.ts";

export interface CreateSqliteIdempotencyStoreArgs {
  readonly db: SqlDatabase;
  readonly table: string;
}

export interface CreateSqliteIdempotencyStoreFunction {
  (args: CreateSqliteIdempotencyStoreArgs): IdempotencyStore;
}

const toRecord = (row: Record<string, unknown>): IdempotencyRecord => ({
  key: String(row.key),
  fingerprint: String(row.fingerprint),
  outcome: JSON.parse(String(row.outcome)) as DispatchOutcome,
  expiresAt: String(row.expires_at),
});

export const createSqliteIdempotencyStore: CreateSqliteIdempotencyStoreFunction = ({
  db,
  table,
}) => ({
  get: async ({ key, now }) => {
    const [row] = await db.all(
      `SELECT "key", "fingerprint", "outcome", "expires_at" FROM ${table} WHERE "key" = ? AND "expires_at" > ?`,
      [key, now.toISOString()],
    );
    return row === undefined ? null : toRecord(row);
  },
  // One statement whose row comes back only when the key was free or expired, so two dispatches
  // racing for it can never both record.
  put: async ({ key, fingerprint, outcome, expiresAt, now }) => {
    const rows = await db.all(
      `INSERT INTO ${table} ("key", "fingerprint", "outcome", "expires_at") VALUES (?, ?, ?, ?)
       ON CONFLICT ("key") DO UPDATE SET
         "fingerprint" = excluded."fingerprint",
         "outcome" = excluded."outcome",
         "expires_at" = excluded."expires_at"
       WHERE ${table}."expires_at" <= ?
       RETURNING "key"`,
      [key, fingerprint, JSON.stringify(outcome), expiresAt, now.toISOString()],
    );
    if (rows.length === 0) throw new IdempotencyKeyTakenError(key);
  },
  purge: async ({ now }) => {
    const rows = await db.all(`DELETE FROM ${table} WHERE "expires_at" <= ? RETURNING "key"`, [
      now.toISOString(),
    ]);
    return rows.length;
  },
});
