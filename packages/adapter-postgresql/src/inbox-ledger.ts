import { ClaimLostError } from "@bounda-dev/core";
import type {
  ClaimRecord,
  ClaimStatus,
  DeadLetterErrorType,
  InboxLedger,
  SettleClaimArgs,
} from "@bounda-dev/core/adapter";
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
  ...(row.claim_id === null || row.claim_id === undefined ? {} : { claimId: String(row.claim_id) }),
  ...(row.last_error === null || row.last_error === undefined
    ? {}
    : { lastError: String(row.last_error) }),
  ...(row.gave_up === null || row.gave_up === undefined
    ? {}
    : { gaveUp: String(row.gave_up) as DeadLetterErrorType }),
});

/**
 * `tryClaim` is a single upsert: PostgreSQL locks the conflicting row, so exactly one racing
 * claimer gets it back. Settling by claim id updates only the row that still carries it.
 */
export const createPostgresqlInboxLedger: CreatePostgresqlInboxLedgerFunction = ({ db, table }) => {
  const settle = async (
    set: string,
    params: readonly unknown[],
    { subscriber, eventId, claimId }: SettleClaimArgs,
  ): Promise<void> => {
    const at = (offset: number) => `$${params.length + offset}`;
    if (claimId === undefined) {
      await db.run(
        `UPDATE ${table} SET ${set} WHERE "subscriber" = ${at(1)} AND "event_id" = ${at(2)}`,
        [...params, subscriber, eventId],
      );
      return;
    }
    const rows = await db.all(
      `UPDATE ${table} SET ${set} WHERE "subscriber" = ${at(1)} AND "event_id" = ${at(2)} AND "claim_id" = ${at(3)} RETURNING "claim_id"`,
      [...params, subscriber, eventId, claimId],
    );
    if (rows.length === 0) throw new ClaimLostError({ subscriber, eventId });
  };

  return {
    tryClaim: async ({ subscriber, eventId, now, leaseMs }) => {
      const expiredBefore = new Date(now.getTime() - leaseMs).toISOString();
      const [row] = await db.all(
        `INSERT INTO ${table} ("subscriber", "event_id", "status", "attempts", "claimed_at", "claim_id") VALUES ($1, $2, 'pending', 1, $3, gen_random_uuid()::text)
       ON CONFLICT ("subscriber", "event_id") DO UPDATE SET
         "status" = 'pending',
         "attempts" = ${table}."attempts" + 1,
         "claimed_at" = excluded."claimed_at",
         "claim_id" = excluded."claim_id"
       WHERE ${table}."status" = 'failed' OR (${table}."status" = 'pending' AND ${table}."claimed_at" < $4)
       RETURNING "claim_id"`,
        [subscriber, eventId, now.toISOString(), expiredBefore],
      );
      return row === undefined ? null : String(row.claim_id);
    },
    complete: (args) => settle(`"status" = 'succeeded'`, [], args),
    fail: (args) =>
      settle(
        `"status" = 'failed', "last_error" = $1, "gave_up" = $2`,
        [args.error, args.gaveUp ?? null],
        args,
      ),
    get: async ({ subscriber, eventId }) => {
      const [row] = await db.all(
        `SELECT "subscriber", "event_id", "status", "attempts", "claimed_at", "claim_id", "last_error", "gave_up" FROM ${table} WHERE "subscriber" = $1 AND "event_id" = $2`,
        [subscriber, eventId],
      );
      return row === undefined ? null : toRecord(row);
    },
  };
};
