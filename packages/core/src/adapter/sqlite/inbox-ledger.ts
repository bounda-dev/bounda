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
  handler: String(row.handler),
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
 * both succeed. Settling or renewing by claim id updates only the row that still carries it.
 */
export const createSqliteInboxLedger: CreateSqliteInboxLedgerFunction = ({ db, table }) => {
  const settle = async (
    set: string,
    params: readonly unknown[],
    { handler, eventId, claimId }: SettleClaimArgs,
  ): Promise<void> => {
    if (claimId === undefined) {
      await db.run(`UPDATE ${table} SET ${set} WHERE "handler" = ? AND "event_id" = ?`, [
        ...params,
        handler,
        eventId,
      ]);
      return;
    }
    const rows = await db.all(
      `UPDATE ${table} SET ${set} WHERE "handler" = ? AND "event_id" = ? AND "claim_id" = ? RETURNING "claim_id"`,
      [...params, handler, eventId, claimId],
    );
    if (rows.length === 0) throw new ClaimLostError({ handler, eventId });
  };

  return {
    tryClaim: async ({ handler, eventId, now, leaseMs }) => {
      const expiredBefore = new Date(now.getTime() - leaseMs).toISOString();
      const [row] = await db.all(
        `INSERT INTO ${table} ("handler", "event_id", "status", "attempts", "claimed_at", "claim_id") VALUES (?, ?, 'pending', 1, ?, lower(hex(randomblob(16))))
       ON CONFLICT ("handler", "event_id") DO UPDATE SET
         "status" = 'pending',
         "attempts" = ${table}."attempts" + 1,
         "claimed_at" = excluded."claimed_at",
         "claim_id" = excluded."claim_id"
       WHERE ${table}."status" = 'failed' OR (${table}."status" = 'pending' AND ${table}."claimed_at" < ?)
       RETURNING "claim_id"`,
        [handler, eventId, now.toISOString(), expiredBefore],
      );
      return row === undefined ? null : String(row.claim_id);
    },
    complete: (args) => settle(`"status" = 'succeeded'`, [], args),
    fail: (args) => settle(`"status" = 'failed', "last_error" = ?`, [args.error], args),
    renew: (args) => settle(`"claimed_at" = ?`, [args.now.toISOString()], args),
    get: async ({ handler, eventId }) => {
      const [row] = await db.all(
        `SELECT "handler", "event_id", "status", "attempts", "claimed_at", "claim_id", "last_error" FROM ${table} WHERE "handler" = ? AND "event_id" = ?`,
        [handler, eventId],
      );
      return row === undefined ? null : toRecord(row);
    },
  };
};
