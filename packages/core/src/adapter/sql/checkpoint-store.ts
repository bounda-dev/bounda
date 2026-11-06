import type { CheckpointStore } from "../storage/checkpoint-store.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface CreateSqlCheckpointStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlCheckpointStoreFunction {
  (args: CreateSqlCheckpointStoreArgs): CheckpointStore;
}

/**
 * The checkpoint store of SQLite and PostgreSQL alike, on the SQL both speak.
 */
export const createSqlCheckpointStore: CreateSqlCheckpointStoreFunction = ({
  db,
  table,
  dialect,
}) => {
  const p = dialect.placeholder;
  return {
    get: async (subscriber) => {
      const [row] = await db.all(`SELECT "position" FROM ${table} WHERE "subscriber" = ${p(1)}`, [
        subscriber,
      ]);
      return Number(row?.position ?? 0);
    },
    set: (subscriber, position) =>
      db.run(
        `INSERT INTO ${table} ("subscriber", "position") VALUES (${p(1)}, ${p(2)}) ON CONFLICT ("subscriber") DO UPDATE SET "position" = excluded."position"`,
        [subscriber, position],
      ),
    // A subscriber without a row is at position 0, so a compare from 0 inserts the row when it is
    // missing and updates it only while it still says 0.
    compareAndSet: async (subscriber, expected, position) => {
      const rows =
        expected === 0
          ? await db.all(
              `INSERT INTO ${table} ("subscriber", "position") VALUES (${p(1)}, ${p(2)}) ON CONFLICT ("subscriber") DO UPDATE SET "position" = excluded."position" WHERE ${table}."position" = 0 RETURNING "position"`,
              [subscriber, position],
            )
          : await db.all(
              `UPDATE ${table} SET "position" = ${p(1)} WHERE "subscriber" = ${p(2)} AND "position" = ${p(3)} RETURNING "position"`,
              [position, subscriber, expected],
            );
      return rows.length === 1;
    },
    remove: (subscriber) =>
      db.run(`DELETE FROM ${table} WHERE "subscriber" = ${p(1)}`, [subscriber]),
    list: async () =>
      (await db.all(`SELECT "subscriber", "position" FROM ${table} ORDER BY "subscriber"`, [])).map(
        (row) => ({ subscriber: String(row.subscriber), position: Number(row.position) }),
      ),
  };
};
