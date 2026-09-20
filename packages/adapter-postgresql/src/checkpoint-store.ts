import type { CheckpointStore } from "@bounda-dev/core/adapter";
import type { PostgresqlDatabase } from "./database.ts";

export interface CreatePostgresqlCheckpointStoreArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
}

export interface CreatePostgresqlCheckpointStoreFunction {
  (args: CreatePostgresqlCheckpointStoreArgs): CheckpointStore;
}

/**
 * One row per subscriber.
 */
export const createPostgresqlCheckpointStore: CreatePostgresqlCheckpointStoreFunction = ({
  db,
  table,
}) => ({
  get: async (subscriber) => {
    const [row] = await db.all(`SELECT "position" FROM ${table} WHERE "subscriber" = $1`, [
      subscriber,
    ]);
    return Number(row?.position ?? 0);
  },
  set: (subscriber, position) =>
    db.run(
      `INSERT INTO ${table} ("subscriber", "position") VALUES ($1, $2) ON CONFLICT ("subscriber") DO UPDATE SET "position" = excluded."position"`,
      [subscriber, position],
    ),
  list: async () =>
    (await db.all(`SELECT "subscriber", "position" FROM ${table} ORDER BY "subscriber"`, [])).map(
      (row) => ({ subscriber: String(row.subscriber), position: Number(row.position) }),
    ),
});
