import { type CausationContext, ScheduledClaimLostError } from "@bounda-dev/core";
import type {
  ClaimedCommand,
  ScheduledClaim,
  ScheduledCommand,
  Scheduler,
} from "@bounda-dev/core/adapter";
import { earliestDue } from "@bounda-dev/core/adapter/sql";
import type { PostgresqlDatabase } from "./database.ts";

export interface CreatePostgresqlSchedulerArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
}

export interface CreatePostgresqlSchedulerFunction {
  (args: CreatePostgresqlSchedulerArgs): Scheduler;
}

const COLUMNS =
  '"dedupe_key", "command_type", "aggregate_id", "payload", "execute_at", "context", "attempts"';

const toScheduled = (row: Record<string, unknown>): ScheduledCommand => ({
  dedupeKey: String(row.dedupe_key),
  command: {
    type: String(row.command_type),
    aggregateId: String(row.aggregate_id),
    payload: row.payload,
  },
  executeAt: String(row.execute_at),
  context: row.context as CausationContext,
  attempts: Number(row.attempts),
});

const toClaimed = (row: Record<string, unknown>): ClaimedCommand => ({
  ...toScheduled(row),
  revision: Number(row.revision),
  claimId: String(row.claim_id),
});

const byExecuteAt = (a: ScheduledCommand, b: ScheduledCommand): number =>
  a.executeAt.localeCompare(b.executeAt) || a.dedupeKey.localeCompare(b.dedupeKey);

/**
 * `claimDue` selects the due rows `FOR UPDATE SKIP LOCKED` and updates them in the same
 * statement, so concurrent workers each get a disjoint set. What a claim writes afterwards goes
 * through only while the row still has its `claim_id` and `revision`, and is rejected once the row
 * no longer has its `claim_id`.
 */
export const createPostgresqlScheduler: CreatePostgresqlSchedulerFunction = ({ db, table }) => {
  /**
   * A write that missed because a reschedule moved the revision still releases the claim, so the
   * rescheduled command does not wait out the lease; one that missed because the claim moved
   * rejects.
   */
  const releaseUnless = async (
    fenced: readonly unknown[],
    claim: ScheduledClaim,
  ): Promise<void> => {
    if (fenced.length > 0) return;
    const released = await db.all(
      `UPDATE ${table} SET "claimed_at" = NULL, "claim_id" = NULL WHERE "dedupe_key" = $1 AND "claim_id" = $2 RETURNING "dedupe_key"`,
      [claim.dedupeKey, claim.claimId],
    );
    if (released.length === 0) throw new ScheduledClaimLostError(claim.dedupeKey);
  };

  const drop = async (claim: ScheduledClaim): Promise<void> =>
    releaseUnless(
      await db.all(
        `DELETE FROM ${table} WHERE "dedupe_key" = $1 AND "claim_id" = $2 AND "revision" = $3 RETURNING "dedupe_key"`,
        [claim.dedupeKey, claim.claimId, claim.revision],
      ),
      claim,
    );

  return {
    schedule: ({ dedupeKey, command, executeAt, context, keepTimingOfSameCommand }) =>
      db.run(
        `INSERT INTO ${table} (${COLUMNS}, "claimed_at", "last_error", "revision") VALUES ($1, $2, $3, $4, $5, $6, 0, NULL, NULL, 0)
       ON CONFLICT ("dedupe_key") DO UPDATE SET
         "command_type" = excluded."command_type",
         "aggregate_id" = excluded."aggregate_id",
         "payload" = excluded."payload",
         "execute_at" = excluded."execute_at",
         "context" = excluded."context",
         "attempts" = 0,
         "last_error" = NULL,
         "revision" = ${table}."revision" + 1
       WHERE NOT (
         ${table}."command_type" = excluded."command_type"
         AND ${table}."aggregate_id" = excluded."aggregate_id"
         AND ${table}."payload" = excluded."payload"
         ${keepTimingOfSameCommand === true ? "" : `AND ${table}."execute_at" = excluded."execute_at"`}
         AND ${table}."context" = excluded."context"
       )`,
        [
          dedupeKey,
          command.type,
          command.aggregateId,
          command.payload,
          executeAt.toISOString(),
          context,
        ],
      ),
    cancel: (dedupeKey) => db.run(`DELETE FROM ${table} WHERE "dedupe_key" = $1`, [dedupeKey]),
    claimDue: async ({ now, limit, leaseMs }) => {
      const nowIso = now.toISOString();
      const expiredBefore = new Date(now.getTime() - leaseMs).toISOString();
      const rows = await db.all(
        `UPDATE ${table} SET
         "attempts" = CASE WHEN ${table}."claimed_at" IS NULL THEN ${table}."attempts" ELSE ${table}."attempts" + 1 END,
         "claimed_at" = $1,
         "claim_id" = gen_random_uuid()::text
       WHERE "dedupe_key" IN (
         SELECT "dedupe_key" FROM ${table}
         WHERE "execute_at" <= $2 AND ("claimed_at" IS NULL OR "claimed_at" < $3)
         ORDER BY "execute_at", "dedupe_key" LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${COLUMNS}, "revision", "claim_id"`,
        [nowIso, nowIso, expiredBefore, limit],
      );
      return rows.map(toClaimed).sort(byExecuteAt);
    },
    nextDueAt: async ({ leaseMs }) => {
      const [row] = await db.all(
        `SELECT MIN(CASE WHEN "claimed_at" IS NULL THEN "execute_at" END) AS "unclaimed", MIN("claimed_at") AS "claimed" FROM ${table}`,
        [],
      );
      return earliestDue({ unclaimed: row?.unclaimed, claimed: row?.claimed, leaseMs });
    },
    complete: drop,
    fail: async ({ claim, error, retryAt }) => {
      if (retryAt === undefined) {
        await drop(claim);
        return;
      }
      await releaseUnless(
        await db.all(
          `UPDATE ${table} SET "execute_at" = $1, "attempts" = "attempts" + 1, "claimed_at" = NULL, "claim_id" = NULL, "last_error" = $2
         WHERE "dedupe_key" = $3 AND "claim_id" = $4 AND "revision" = $5 RETURNING "dedupe_key"`,
          [retryAt.toISOString(), error, claim.dedupeKey, claim.claimId, claim.revision],
        ),
        claim,
      );
    },
    defer: async ({ claim, executeAt }) => {
      await releaseUnless(
        await db.all(
          `UPDATE ${table} SET "execute_at" = $1, "claimed_at" = NULL, "claim_id" = NULL
         WHERE "dedupe_key" = $2 AND "claim_id" = $3 AND "revision" = $4 RETURNING "dedupe_key"`,
          [executeAt.toISOString(), claim.dedupeKey, claim.claimId, claim.revision],
        ),
        claim,
      );
    },
    renew: async ({ claim, now }) => {
      const renewed = await db.all(
        `UPDATE ${table} SET "claimed_at" = $1 WHERE "dedupe_key" = $2 AND "claim_id" = $3 RETURNING "dedupe_key"`,
        [now.toISOString(), claim.dedupeKey, claim.claimId],
      );
      if (renewed.length === 0) throw new ScheduledClaimLostError(claim.dedupeKey);
    },
    list: async ({ limit, offset = 0 } = {}) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} ORDER BY "execute_at", "dedupe_key" LIMIT $1 OFFSET $2`,
          [limit ?? null, offset],
        )
      ).map(toScheduled),
  };
};
