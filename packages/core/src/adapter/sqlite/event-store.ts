import { ConcurrencyError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { EventMetadata } from "../../contracts/metadata.ts";
import type { EventStore } from "../index.ts";
import type { SqlDatabase } from "../sql/database.ts";

export interface CreateSqliteEventStoreArgs {
  readonly db: SqlDatabase;
  readonly table: string;
}

export interface CreateSqliteEventStoreFunction {
  (args: CreateSqliteEventStoreArgs): EventStore;
}

const COLUMNS =
  '"position", "id", "aggregate_type", "aggregate_id", "version", "type", "payload", "timestamp", "metadata"';

const toStoredEvent = (row: Record<string, unknown>): StoredEvent => ({
  position: Number(row.position),
  id: String(row.id),
  aggregateType: String(row.aggregate_type),
  aggregateId: String(row.aggregate_id),
  version: Number(row.version),
  type: String(row.type),
  payload: JSON.parse(String(row.payload)) as unknown,
  timestamp: String(row.timestamp),
  metadata: JSON.parse(String(row.metadata)) as EventMetadata,
});

/**
 * Event store on one SQLite table. `append` checks the stream version and inserts inside a write
 * transaction; a stale version rolls back and raises `ConcurrencyError`.
 */
export const createSqliteEventStore: CreateSqliteEventStoreFunction = ({ db, table }) => {
  const currentVersion = async (
    executor: Pick<SqlDatabase, "all">,
    aggregateType: string,
    aggregateId: string,
  ): Promise<number> => {
    const [row] = await executor.all(
      `SELECT COALESCE(MAX("version"), 0) AS "version" FROM ${table} WHERE "aggregate_type" = ? AND "aggregate_id" = ?`,
      [aggregateType, aggregateId],
    );
    return Number(row?.version ?? 0);
  };

  return {
    append: ({ aggregateType, aggregateId, expectedVersion, events }) =>
      db.write(async (tx) => {
        const actualVersion = await currentVersion(tx, aggregateType, aggregateId);
        if (actualVersion !== expectedVersion) {
          throw new ConcurrencyError({
            streamId: `${aggregateType}:${aggregateId}`,
            expectedVersion,
            actualVersion,
          });
        }
        const stored: StoredEvent[] = [];
        for (const event of events) {
          const [row] = await tx.all(
            `INSERT INTO ${table} ("id", "aggregate_type", "aggregate_id", "version", "type", "payload", "timestamp", "metadata") VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING "position"`,
            [
              event.id,
              event.aggregateType,
              event.aggregateId,
              event.version,
              event.type,
              JSON.stringify(event.payload),
              event.timestamp,
              JSON.stringify(event.metadata),
            ],
          );
          stored.push({ ...event, position: Number(row?.position) });
        }
        return { version: actualVersion + stored.length, events: stored };
      }),
    load: async ({ aggregateType, aggregateId, fromVersion = 1 }) => {
      const rows = await db.all(
        `SELECT ${COLUMNS} FROM ${table} WHERE "aggregate_type" = ? AND "aggregate_id" = ? AND "version" >= ? ORDER BY "version"`,
        [aggregateType, aggregateId, fromVersion],
      );
      const events = rows.map(toStoredEvent);
      const last = events.at(-1);
      const version =
        fromVersion <= 1
          ? (last?.version ?? 0)
          : await currentVersion(db, aggregateType, aggregateId);
      return { events, version };
    },
    readAll: async ({ afterPosition, limit }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE "position" > ? ORDER BY "position" LIMIT ?`,
          [afterPosition, limit],
        )
      ).map(toStoredEvent),
    lastPosition: async () => {
      const [row] = await db.all(
        `SELECT COALESCE(MAX("position"), 0) AS "position" FROM ${table}`,
        [],
      );
      return Number(row?.position ?? 0);
    },
  };
};
