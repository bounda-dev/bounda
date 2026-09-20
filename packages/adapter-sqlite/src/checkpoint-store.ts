import type { CheckpointStore } from "@bounda-dev/core/adapter";
import type { SqliteDatabase } from "./database.ts";

export interface CreateSqliteCheckpointStoreArgs {
  readonly db: SqliteDatabase;
  readonly table: string;
}

export interface CreateSqliteCheckpointStoreFunction {
  (args: CreateSqliteCheckpointStoreArgs): CheckpointStore;
}

/**
 * One row per subscriber.
 */
export const createSqliteCheckpointStore: CreateSqliteCheckpointStoreFunction = ({
  db,
  table,
}) => ({
  get: async (subscriber) => {
    const [row] = await db.all(`SELECT "position" FROM ${table} WHERE "subscriber" = ?`, [
      subscriber,
    ]);
    return Number(row?.position ?? 0);
  },
  set: (subscriber, position) =>
    db.run(
      `INSERT INTO ${table} ("subscriber", "position") VALUES (?, ?) ON CONFLICT ("subscriber") DO UPDATE SET "position" = excluded."position"`,
      [subscriber, position],
    ),
  list: async () =>
    (await db.all(`SELECT "subscriber", "position" FROM ${table} ORDER BY "subscriber"`, [])).map(
      (row) => ({ subscriber: String(row.subscriber), position: Number(row.position) }),
    ),
});
