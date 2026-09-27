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
  claimedAt: String(row.claimed_at),
});

const byExecuteAt = (a: ScheduledCommand, b: ScheduledCommand): number =>
  a.executeAt.localeCompare(b.executeAt) || a.dedupeKey.localeCompare(b.dedupeKey);

/**
 * Scheduler on one table. `claimDue` is a single `UPDATE ... WHERE dedupe_key IN (SELECT ...)
 * RETURNING`, so concurrent workers never claim the same command. `complete` and `fail` write only
 * while the row still has the claim's `claimed_at` and `revision`, then release a claim that a
 * reschedule left behind.
 */
export const createSqliteScheduler: CreateSqliteSchedulerFunction = ({ db, table }) => {
  const release = (claim: ScheduledClaim): Promise<void> =>
    db.run(`UPDATE ${table} SET "claimed_at" = NULL WHERE "dedupe_key" = ? AND "claimed_at" = ?`, [
      claim.dedupeKey,
      claim.claimedAt,
    ]);

  const drop = async (claim: ScheduledClaim): Promise<void> => {
    await db.run(
      `DELETE FROM ${table} WHERE "dedupe_key" = ? AND "claimed_at" = ? AND "revision" = ?`,
      [claim.dedupeKey, claim.claimedAt, claim.revision],
    );
    await release(claim);
  };

  return {
    schedule: ({ dedupeKey, command, executeAt, context }) =>
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
         AND ${table}."execute_at" = excluded."execute_at"
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
         "claimed_at" = ?
       WHERE "dedupe_key" IN (
         SELECT "dedupe_key" FROM ${table}
         WHERE "execute_at" <= ? AND ("claimed_at" IS NULL OR "claimed_at" < ?)
         ORDER BY "execute_at", "dedupe_key" LIMIT ?
       )
       RETURNING ${COLUMNS}, "revision", "claimed_at"`,
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
      await db.run(
        `UPDATE ${table} SET "execute_at" = ?, "attempts" = "attempts" + 1, "claimed_at" = NULL, "last_error" = ?
       WHERE "dedupe_key" = ? AND "claimed_at" = ? AND "revision" = ?`,
        [retryAt.toISOString(), error, claim.dedupeKey, claim.claimedAt, claim.revision],
      );
      await release(claim);
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
