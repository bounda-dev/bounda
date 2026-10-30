import type { Snapshot, SnapshotStore } from "@bounda-dev/core/adapter";
import type { SqlExecutor } from "@bounda-dev/core/adapter/sql";

export interface CreatePostgresqlSnapshotStoreArgs {
  readonly db: SqlExecutor;
  readonly table: string;
}

export interface CreatePostgresqlSnapshotStoreFunction {
  (args: CreatePostgresqlSnapshotStoreArgs): SnapshotStore;
}

const toSnapshot = (row: Record<string, unknown>): Snapshot => ({
  aggregateType: String(row.aggregate_type),
  aggregateId: String(row.aggregate_id),
  version: Number(row.version),
  fingerprint: String(row.fingerprint),
  state: String(row.state),
});

export const createPostgresqlSnapshotStore: CreatePostgresqlSnapshotStoreFunction = ({
  db,
  table,
}) => ({
  get: async ({ aggregateType, aggregateId }) => {
    const [row] = await db.all(
      `SELECT "aggregate_type", "aggregate_id", "version", "fingerprint", "state" FROM ${table} WHERE "aggregate_type" = $1 AND "aggregate_id" = $2`,
      [aggregateType, aggregateId],
    );
    return row === undefined ? null : toSnapshot(row);
  },
  put: ({ aggregateType, aggregateId, version, fingerprint, state }) =>
    db.run(
      `INSERT INTO ${table} ("aggregate_type", "aggregate_id", "version", "fingerprint", "state") VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("aggregate_type", "aggregate_id") DO UPDATE SET "version" = excluded."version", "fingerprint" = excluded."fingerprint", "state" = excluded."state"`,
      [aggregateType, aggregateId, version, fingerprint, state],
    ),
  remove: ({ aggregateType, aggregateId }) =>
    db.run(`DELETE FROM ${table} WHERE "aggregate_type" = $1 AND "aggregate_id" = $2`, [
      aggregateType,
      aggregateId,
    ]),
});
