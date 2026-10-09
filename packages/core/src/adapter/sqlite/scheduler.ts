import { ScheduledClaimLostError } from "../../contracts/errors.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { ClaimedCommand, ScheduledClaim, ScheduledCommand, Scheduler } from "../index.ts";
import type { SqlDatabase } from "../sql/database.ts";
import { earliestDue } from "../sql/index.ts";

export interface CreateSqliteSchedulerArgs {
  readonly db: SqlDatabase;
  readonly table: string;
}

export interface CreateSqliteSchedulerFunction {
  (args: CreateSqliteSchedulerArgs): Scheduler;
}

const COLUMNS =
  '"dedupe_key", "command_type", "aggregate_id", "payload", "execute_at", "context", "attempts"';

const toScheduled = (row: Record<string, unknown>): ScheduledCommand => ({
  dedupeKey: String(row.dedupe_key),
  command: {
    type: String(row.command_type),
    aggregateId: String(row.aggregate_id),
    payload: JSON.parse(String(row.payload)) as unknown,
  },
  executeAt: String(row.execute_at),
  context: JSON.parse(String(row.context)) as CausationContext,
  attempts: Number(row.attempts),
});

const toClaimed = (row: Record<string, unknown>): ClaimedCommand => ({
  ...toScheduled(row),
  revision: Number(row.revision),
  claimId: String(row.claim_id),
});

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// `RETURNING` keeps no order: the claimed rows are sorted again as the query sorted them.
const byExecuteAt = (a: ScheduledCommand, b: ScheduledCommand): number =>
  byCodeUnit(a.executeAt, b.executeAt) || byCodeUnit(a.dedupeKey, b.dedupeKey);

/**
 * Scheduler on one table. `claimDue` is a single `UPDATE ... WHERE dedupe_key IN (SELECT ...)
 * RETURNING`, so concurrent workers never claim the same command. `complete`, `fail` and `defer`
 * write only while the row still has the claim's `claim_id` and `revision`, otherwise release a
 * claim that a reschedule left behind, and reject with `ScheduledClaimLostError`, as `renew` does,
 * once the row no longer has the `claim_id`.
 */
export const createSqliteScheduler: CreateSqliteSchedulerFunction = ({ db, table }) => {
  const releaseUnless = async (
    fenced: readonly unknown[],
    claim: ScheduledClaim,
  ): Promise<void> => {
    if (fenced.length > 0) return;
    const released = await db.all(
      `UPDATE ${table} SET "claimed_at" = NULL, "claim_id" = NULL WHERE "dedupe_key" = ? AND "claim_id" = ? RETURNING "dedupe_key"`,
      [claim.dedupeKey, claim.claimId],
    );
    if (released.length === 0) throw new ScheduledClaimLostError(claim.dedupeKey);
  };

  const drop = async (claim: ScheduledClaim): Promise<void> =>
    releaseUnless(
      await db.all(
        `DELETE FROM ${table} WHERE "dedupe_key" = ? AND "claim_id" = ? AND "revision" = ? RETURNING "dedupe_key"`,
        [claim.dedupeKey, claim.claimId, claim.revision],
      ),
      claim,
    );

  return {
    schedule: ({ dedupeKey, command, executeAt, context, keepTimingOfSameCommand }) =>
      db.run(
        `INSERT INTO ${table} (${COLUMNS}, "claimed_at", "last_error", "revision") VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0)
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
          JSON.stringify(command.payload),
          executeAt.toISOString(),
          JSON.stringify(context),
        ],
      ),
    cancel: (dedupeKey) => db.run(`DELETE FROM ${table} WHERE "dedupe_key" = ?`, [dedupeKey]),
    claimDue: async ({ now, limit, leaseMs }) => {
      const nowIso = now.toISOString();
      const expiredBefore = new Date(now.getTime() - leaseMs).toISOString();
      const rows = await db.all(
        `UPDATE ${table} SET
         "attempts" = CASE WHEN "claimed_at" IS NULL THEN "attempts" ELSE "attempts" + 1 END,
         "claimed_at" = ?,
         "claim_id" = lower(hex(randomblob(16)))
       WHERE "dedupe_key" IN (
         SELECT "dedupe_key" FROM ${table}
         WHERE "execute_at" <= ? AND ("claimed_at" IS NULL OR "claimed_at" < ?)
         ORDER BY "execute_at", "dedupe_key" LIMIT ?
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
          `UPDATE ${table} SET "execute_at" = ?, "attempts" = "attempts" + 1, "claimed_at" = NULL, "claim_id" = NULL, "last_error" = ?
         WHERE "dedupe_key" = ? AND "claim_id" = ? AND "revision" = ? RETURNING "dedupe_key"`,
          [retryAt.toISOString(), error, claim.dedupeKey, claim.claimId, claim.revision],
        ),
        claim,
      );
    },
    defer: async ({ claim, executeAt }) => {
      await releaseUnless(
        await db.all(
          `UPDATE ${table} SET "execute_at" = ?, "claimed_at" = NULL, "claim_id" = NULL
         WHERE "dedupe_key" = ? AND "claim_id" = ? AND "revision" = ? RETURNING "dedupe_key"`,
          [executeAt.toISOString(), claim.dedupeKey, claim.claimId, claim.revision],
        ),
        claim,
      );
    },
    renew: async ({ claim, now }) => {
      const renewed = await db.all(
        `UPDATE ${table} SET "claimed_at" = ? WHERE "dedupe_key" = ? AND "claim_id" = ? RETURNING "dedupe_key"`,
        [now.toISOString(), claim.dedupeKey, claim.claimId],
      );
      if (renewed.length === 0) throw new ScheduledClaimLostError(claim.dedupeKey);
    },
    list: async ({ limit, offset = 0 } = {}) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} ORDER BY "execute_at", "dedupe_key" LIMIT ? OFFSET ?`,
          [limit ?? -1, offset],
        )
      ).map(toScheduled),
  };
};
