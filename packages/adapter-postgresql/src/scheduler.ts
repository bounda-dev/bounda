import type { CausationContext } from "@bounda-dev/core";
import type { ScheduledCommand, Scheduler } from "@bounda-dev/core/adapter";
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

const byExecuteAt = (a: ScheduledCommand, b: ScheduledCommand): number =>
  a.executeAt.localeCompare(b.executeAt) || a.dedupeKey.localeCompare(b.dedupeKey);

/**
 * Scheduler on one table. `claimDue` selects the due rows `FOR UPDATE SKIP LOCKED` and updates
 * them in the same statement, so concurrent workers each get a disjoint set.
 */
export const createPostgresqlScheduler: CreatePostgresqlSchedulerFunction = ({ db, table }) => ({
  schedule: ({ dedupeKey, command, executeAt, context }) =>
    db.run(
      `INSERT INTO ${table} (${COLUMNS}, "claimed_at", "last_error") VALUES ($1, $2, $3, $4, $5, $6, 0, NULL, NULL)
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
         "claimed_at" = $1
       WHERE "dedupe_key" IN (
         SELECT "dedupe_key" FROM ${table}
         WHERE "execute_at" <= $2 AND ("claimed_at" IS NULL OR "claimed_at" < $3)
         ORDER BY "execute_at", "dedupe_key" LIMIT $4
         FOR UPDATE SKIP LOCKED
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
  complete: (dedupeKey) => db.run(`DELETE FROM ${table} WHERE "dedupe_key" = $1`, [dedupeKey]),
  fail: ({ dedupeKey, error, retryAt }) =>
    retryAt === undefined
      ? db.run(`DELETE FROM ${table} WHERE "dedupe_key" = $1`, [dedupeKey])
      : db.run(
          `UPDATE ${table} SET "execute_at" = $1, "attempts" = "attempts" + 1, "claimed_at" = NULL, "last_error" = $2 WHERE "dedupe_key" = $3`,
          [retryAt.toISOString(), error, dedupeKey],
        ),
  list: async ({ limit, offset = 0 } = {}) =>
    (
      await db.all(
        `SELECT ${COLUMNS} FROM ${table} ORDER BY "execute_at", "dedupe_key" LIMIT $1 OFFSET $2`,
        [limit ?? null, offset],
      )
    ).map(toScheduled),
});
