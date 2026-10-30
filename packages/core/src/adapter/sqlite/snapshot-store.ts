import type { Snapshot, SnapshotStore } from "../index.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";

export interface CreateSqliteSnapshotStoreArgs {
  readonly db: SqlExecutor;
  readonly table: string;
}

export interface CreateSqliteSnapshotStoreFunction {
  (args: CreateSqliteSnapshotStoreArgs): SnapshotStore;
}

const toSnapshot = (row: Record<string, unknown>): Snapshot => ({
  aggregateType: String(row.aggregate_type),
  aggregateId: String(row.aggregate_id),
  version: Number(row.version),
  fingerprint: String(row.fingerprint),
  state: String(row.state),
});

export const createSqliteSnapshotStore: CreateSqliteSnapshotStoreFunction = ({ db, table }) => ({
  get: async ({ aggregateType, aggregateId }) => {
    const [row] = await db.all(
      `SELECT "aggregate_type", "aggregate_id", "version", "fingerprint", "state" FROM ${table} WHERE "aggregate_type" = ? AND "aggregate_id" = ?`,
      [aggregateType, aggregateId],
    );
    return row === undefined ? null : toSnapshot(row);
  },
  put: ({ aggregateType, aggregateId, version, fingerprint, state }) =>
    db.run(
      `INSERT INTO ${table} ("aggregate_type", "aggregate_id", "version", "fingerprint", "state") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("aggregate_type", "aggregate_id") DO UPDATE SET "version" = excluded."version", "fingerprint" = excluded."fingerprint", "state" = excluded."state"`,
      [aggregateType, aggregateId, version, fingerprint, state],
    ),
  remove: ({ aggregateType, aggregateId }) =>
    db.run(`DELETE FROM ${table} WHERE "aggregate_type" = ? AND "aggregate_id" = ?`, [
      aggregateType,
      aggregateId,
    ]),
});
