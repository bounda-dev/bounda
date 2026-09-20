import type { ClaimRecord, ClaimStatus, InboxLedger } from "@bounda-dev/core/adapter";
import type { PostgresqlDatabase } from "./database.ts";

export interface CreatePostgresqlInboxLedgerArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
}

export interface CreatePostgresqlInboxLedgerFunction {
  (args: CreatePostgresqlInboxLedgerArgs): InboxLedger;
}

const toRecord = (row: Record<string, unknown>): ClaimRecord => ({
  subscriber: String(row.subscriber),
  eventId: String(row.event_id),
  status: String(row.status) as ClaimStatus,
  attempts: Number(row.attempts),
  claimedAt: String(row.claimed_at),
  ...(row.last_error === null || row.last_error === undefined
    ? {}
    : { lastError: String(row.last_error) }),
});

/**
 * Inbox ledger on one table. `tryClaim` is a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE
 * ... RETURNING`; PostgreSQL locks the conflicting row, so exactly one racing claimer gets it back.
 */
export const createPostgresqlInboxLedger: CreatePostgresqlInboxLedgerFunction = ({
  db,
  table,
}) => ({
  tryClaim: async ({ subscriber, eventId, now, leaseMs }) => {
    const expiredBefore = new Date(now.getTime() - leaseMs).toISOString();
    const rows = await db.all(
      `INSERT INTO ${table} ("subscriber", "event_id", "status", "attempts", "claimed_at") VALUES ($1, $2, 'pending', 1, $3)
       ON CONFLICT ("subscriber", "event_id") DO UPDATE SET
         "status" = 'pending',
         "attempts" = ${table}."attempts" + 1,
         "claimed_at" = excluded."claimed_at"
       WHERE ${table}."status" = 'failed' OR (${table}."status" = 'pending' AND ${table}."claimed_at" < $4)
       RETURNING "attempts"`,
      [subscriber, eventId, now.toISOString(), expiredBefore],
    );
    return rows.length > 0;
  },
  complete: ({ subscriber, eventId }) =>
    db.run(
      `UPDATE ${table} SET "status" = 'succeeded' WHERE "subscriber" = $1 AND "event_id" = $2`,
      [subscriber, eventId],
    ),
  fail: ({ subscriber, eventId, error }) =>
    db.run(
      `UPDATE ${table} SET "status" = 'failed', "last_error" = $1 WHERE "subscriber" = $2 AND "event_id" = $3`,
      [error, subscriber, eventId],
    ),
  get: async ({ subscriber, eventId }) => {
    const [row] = await db.all(
      `SELECT "subscriber", "event_id", "status", "attempts", "claimed_at", "last_error" FROM ${table} WHERE "subscriber" = $1 AND "event_id" = $2`,
      [subscriber, eventId],
    );
    return row === undefined ? null : toRecord(row);
  },
});
