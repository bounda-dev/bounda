import type { ClaimRecord, ClaimStatus, InboxLedger } from "../index.ts";
import type { SqlDatabase } from "../sql/database.ts";

export interface CreateSqliteInboxLedgerArgs {
  readonly db: SqlDatabase;
  readonly table: string;
}

export interface CreateSqliteInboxLedgerFunction {
  (args: CreateSqliteInboxLedgerArgs): InboxLedger;
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
 * ... RETURNING`: the row comes back only when the claim was won, so two racing claimers can never
 * both succeed.
 */
export const createSqliteInboxLedger: CreateSqliteInboxLedgerFunction = ({ db, table }) => ({
  tryClaim: async ({ subscriber, eventId, now, leaseMs }) => {
    const expiredBefore = new Date(now.getTime() - leaseMs).toISOString();
    const rows = await db.all(
      `INSERT INTO ${table} ("subscriber", "event_id", "status", "attempts", "claimed_at") VALUES (?, ?, 'pending', 1, ?)
       ON CONFLICT ("subscriber", "event_id") DO UPDATE SET
         "status" = 'pending',
         "attempts" = ${table}."attempts" + 1,
         "claimed_at" = excluded."claimed_at"
       WHERE ${table}."status" = 'failed' OR (${table}."status" = 'pending' AND ${table}."claimed_at" < ?)
       RETURNING "attempts"`,
      [subscriber, eventId, now.toISOString(), expiredBefore],
    );
    return rows.length > 0;
  },
  complete: ({ subscriber, eventId }) =>
    db.run(`UPDATE ${table} SET "status" = 'succeeded' WHERE "subscriber" = ? AND "event_id" = ?`, [
      subscriber,
      eventId,
    ]),
  fail: ({ subscriber, eventId, error }) =>
    db.run(
      `UPDATE ${table} SET "status" = 'failed', "last_error" = ? WHERE "subscriber" = ? AND "event_id" = ?`,
      [error, subscriber, eventId],
    ),
  get: async ({ subscriber, eventId }) => {
    const [row] = await db.all(
      `SELECT "subscriber", "event_id", "status", "attempts", "claimed_at", "last_error" FROM ${table} WHERE "subscriber" = ? AND "event_id" = ?`,
      [subscriber, eventId],
    );
    return row === undefined ? null : toRecord(row);
  },
});
