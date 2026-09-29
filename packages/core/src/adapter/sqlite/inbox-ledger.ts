import { ClaimLostError } from "../../contracts/errors.ts";
import type { ClaimRecord, ClaimStatus, InboxLedger, SettleClaimArgs } from "../index.ts";
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
  ...(row.claim_id === null || row.claim_id === undefined ? {} : { claimId: String(row.claim_id) }),
  ...(row.last_error === null || row.last_error === undefined
    ? {}
    : { lastError: String(row.last_error) }),
});

/**
 * Inbox ledger on one table. `tryClaim` is a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE
 * ... RETURNING`: the row comes back only when the claim was won, so two racing claimers can never
 * both succeed. Settling by claim id updates only the row that still carries it.
 */
export const createSqliteInboxLedger: CreateSqliteInboxLedgerFunction = ({ db, table }) => {
  const settle = async (
    set: string,
    params: readonly unknown[],
    { subscriber, eventId, claimId }: SettleClaimArgs,
  ): Promise<void> => {
    if (claimId === undefined) {
      await db.run(`UPDATE ${table} SET ${set} WHERE "subscriber" = ? AND "event_id" = ?`, [
        ...params,
        subscriber,
        eventId,
      ]);
      return;
    }
    const rows = await db.all(
      `UPDATE ${table} SET ${set} WHERE "subscriber" = ? AND "event_id" = ? AND "claim_id" = ? RETURNING "claim_id"`,
      [...params, subscriber, eventId, claimId],
    );
    if (rows.length === 0) throw new ClaimLostError({ subscriber, eventId });
  };

  return {
    tryClaim: async ({ subscriber, eventId, now, leaseMs }) => {
      const expiredBefore = new Date(now.getTime() - leaseMs).toISOString();
      const [row] = await db.all(
        `INSERT INTO ${table} ("subscriber", "event_id", "status", "attempts", "claimed_at", "claim_id") VALUES (?, ?, 'pending', 1, ?, lower(hex(randomblob(16))))
       ON CONFLICT ("subscriber", "event_id") DO UPDATE SET
         "status" = 'pending',
         "attempts" = ${table}."attempts" + 1,
         "claimed_at" = excluded."claimed_at",
         "claim_id" = excluded."claim_id"
       WHERE ${table}."status" = 'failed' OR (${table}."status" = 'pending' AND ${table}."claimed_at" < ?)
       RETURNING "claim_id"`,
        [subscriber, eventId, now.toISOString(), expiredBefore],
      );
      return row === undefined ? null : String(row.claim_id);
    },
    complete: (args) => settle(`"status" = 'succeeded'`, [], args),
    fail: (args) => settle(`"status" = 'failed', "last_error" = ?`, [args.error], args),
    get: async ({ subscriber, eventId }) => {
      const [row] = await db.all(
        `SELECT "subscriber", "event_id", "status", "attempts", "claimed_at", "claim_id", "last_error" FROM ${table} WHERE "subscriber" = ? AND "event_id" = ?`,
        [subscriber, eventId],
      );
      return row === undefined ? null : toRecord(row);
    },
  };
};
