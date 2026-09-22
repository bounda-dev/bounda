import type { CausationContext } from "../../contracts/metadata.ts";
import type { ScheduledCommand, Scheduler } from "../index.ts";
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

const byExecuteAt = (a: ScheduledCommand, b: ScheduledCommand): number =>
  a.executeAt.localeCompare(b.executeAt) || a.dedupeKey.localeCompare(b.dedupeKey);

/**
 * Scheduler on one table. `claimDue` is a single `UPDATE ... WHERE dedupe_key IN (SELECT ...)
 * RETURNING`, so concurrent workers never claim the same command.
 */
export const createSqliteScheduler: CreateSqliteSchedulerFunction = ({ db, table }) => ({
  schedule: ({ dedupeKey, command, executeAt, context }) =>
    db.run(
      `INSERT INTO ${table} (${COLUMNS}, "claimed_at", "last_error") VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT ("dedupe_key") DO UPDATE SET
         "command_type" = excluded."command_type",
         "aggregate_id" = excluded."aggregate_id",
         "payload" = excluded."payload",
         "execute_at" = excluded."execute_at",
         "context" = excluded."context",
         "attempts" = 0,
         "claimed_at" = NULL,
         "last_error" = NULL`,
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
       RETURNING ${COLUMNS}`,
      [nowIso, nowIso, expiredBefore, limit],
    );
    return rows.map(toScheduled).sort(byExecuteAt);
  },
  nextDueAt: async ({ leaseMs }) => {
    const [row] = await db.all(
      `SELECT MIN(CASE WHEN "claimed_at" IS NULL THEN "execute_at" END) AS "unclaimed", MIN("claimed_at") AS "claimed" FROM ${table}`,
      [],
    );
    return earliestDue({ unclaimed: row?.unclaimed, claimed: row?.claimed, leaseMs });
  },
  complete: (dedupeKey) => db.run(`DELETE FROM ${table} WHERE "dedupe_key" = ?`, [dedupeKey]),
  fail: ({ dedupeKey, error, retryAt }) =>
    retryAt === undefined
      ? db.run(`DELETE FROM ${table} WHERE "dedupe_key" = ?`, [dedupeKey])
      : db.run(
          `UPDATE ${table} SET "execute_at" = ?, "attempts" = "attempts" + 1, "claimed_at" = NULL, "last_error" = ? WHERE "dedupe_key" = ?`,
          [retryAt.toISOString(), error, dedupeKey],
        ),
  list: async ({ limit, offset = 0 } = {}) =>
    (
      await db.all(
        `SELECT ${COLUMNS} FROM ${table} ORDER BY "execute_at", "dedupe_key" LIMIT ? OFFSET ?`,
        [limit ?? -1, offset],
      )
    ).map(toScheduled),
});
