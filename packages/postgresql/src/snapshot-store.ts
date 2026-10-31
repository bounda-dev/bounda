import type { Snapshot, SnapshotStore } from "@bounda-dev/core/adapter";
import type { SqlExecutor } from "@bounda-dev/core/adapter/sql";

export interface CreatePostgresqlSnapshotStoreArgs {
  readonly db: SqlExecutor;
  readonly table: string;
  // The personal keys a snapshot's persons must hold for `put` to write it.
  readonly personalKeys: string;
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
  persons: (row.persons as readonly string[]).map(String),
});

export const createPostgresqlSnapshotStore: CreatePostgresqlSnapshotStoreFunction = ({
  db,
  table,
  personalKeys,
}) => ({
  get: async ({ aggregateType, aggregateId }) => {
    const [row] = await db.all(
      `SELECT "aggregate_type", "aggregate_id", "version", "fingerprint", "state", "persons" FROM ${table} WHERE "aggregate_type" = $1 AND "aggregate_id" = $2`,
      [aggregateType, aggregateId],
    );
    return row === undefined ? null : toSnapshot(row);
  },
  // The keys are locked until the write commits: a forget that removes one waits for it, and
  // then finds the snapshot to remove; one that removed it first leaves the write nothing.
  put: ({ aggregateType, aggregateId, version, fingerprint, state, persons }) =>
    db.run(
      `INSERT INTO ${table} ("aggregate_type", "aggregate_id", "version", "fingerprint", "state", "persons") SELECT $1, $2, $3, $4, $5, $6::text[] WHERE (SELECT count(*) FROM (SELECT 1 FROM ${personalKeys} WHERE "person" = ANY($6::text[]) FOR SHARE) AS "held") = cardinality($6::text[]) ON CONFLICT ("aggregate_type", "aggregate_id") DO UPDATE SET "version" = excluded."version", "fingerprint" = excluded."fingerprint", "state" = excluded."state", "persons" = excluded."persons"`,
      [aggregateType, aggregateId, version, fingerprint, state, [...persons]],
    ),
  remove: ({ aggregateType, aggregateId }) =>
    db.run(`DELETE FROM ${table} WHERE "aggregate_type" = $1 AND "aggregate_id" = $2`, [
      aggregateType,
      aggregateId,
    ]),
  forget: (person) => db.run(`DELETE FROM ${table} WHERE $1 = ANY("persons")`, [person]),
});
