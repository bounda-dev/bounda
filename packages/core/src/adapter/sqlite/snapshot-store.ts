import type { Snapshot, SnapshotStore } from "../index.ts";
import type { SqlExecutor } from "../sql/sql-table.ts";

export interface CreateSqliteSnapshotStoreArgs {
  readonly db: SqlExecutor;
  readonly table: string;
  // The personal keys a snapshot's persons must hold for `put` to write it.
  readonly personalKeys: string;
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
  persons: JSON.parse(String(row.persons)) as string[],
});

export const createSqliteSnapshotStore: CreateSqliteSnapshotStoreFunction = ({
  db,
  table,
  personalKeys,
}) => ({
  get: async ({ aggregateType, aggregateId }) => {
    const [row] = await db.all(
      `SELECT "aggregate_type", "aggregate_id", "version", "fingerprint", "state", "persons" FROM ${table} WHERE "aggregate_type" = ? AND "aggregate_id" = ?`,
      [aggregateType, aggregateId],
    );
    return row === undefined ? null : toSnapshot(row);
  },
  // One statement, so a forget that removed a key before it runs leaves it nothing to write.
  put: ({ aggregateType, aggregateId, version, fingerprint, state, persons }) =>
    db.run(
      `INSERT INTO ${table} ("aggregate_type", "aggregate_id", "version", "fingerprint", "state", "persons") SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM ${personalKeys} WHERE "person" IN (SELECT "value" FROM json_each(?))) = ? ON CONFLICT ("aggregate_type", "aggregate_id") DO UPDATE SET "version" = excluded."version", "fingerprint" = excluded."fingerprint", "state" = excluded."state", "persons" = excluded."persons"`,
      [
        aggregateType,
        aggregateId,
        version,
        fingerprint,
        state,
        JSON.stringify(persons),
        JSON.stringify(persons),
        persons.length,
      ],
    ),
  remove: ({ aggregateType, aggregateId }) =>
    db.run(`DELETE FROM ${table} WHERE "aggregate_type" = ? AND "aggregate_id" = ?`, [
      aggregateType,
      aggregateId,
    ]),
  forget: (person) =>
    db.run(
      `DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM json_each(${table}."persons") WHERE "value" = ?)`,
      [person],
    ),
});
