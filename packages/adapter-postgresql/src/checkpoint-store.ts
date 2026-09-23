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
 * One row per subscriber. A subscriber without a row is at position 0, so `compareAndSet` from 0
 * inserts the row when it is missing and updates it only while it still says 0.
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
  compareAndSet: async (subscriber, expected, position) => {
    const rows =
      expected === 0
        ? await db.all(
            `INSERT INTO ${table} ("subscriber", "position") VALUES ($1, $2) ON CONFLICT ("subscriber") DO UPDATE SET "position" = excluded."position" WHERE ${table}."position" = 0 RETURNING "position"`,
            [subscriber, position],
          )
        : await db.all(
            `UPDATE ${table} SET "position" = $1 WHERE "subscriber" = $2 AND "position" = $3 RETURNING "position"`,
            [position, subscriber, expected],
          );
    return rows.length === 1;
  },
  remove: (subscriber) => db.run(`DELETE FROM ${table} WHERE "subscriber" = $1`, [subscriber]),
  list: async () =>
    (await db.all(`SELECT "subscriber", "position" FROM ${table} ORDER BY "subscriber"`, [])).map(
      (row) => ({ subscriber: String(row.subscriber), position: Number(row.position) }),
    ),
});
