import { ConcurrencyError, type EventMetadata, type StoredEvent } from "@bounda-dev/core";
import type { EventStore } from "@bounda-dev/core/adapter";
import type { PostgresqlDatabase } from "./database.ts";

export interface CreatePostgresqlEventStoreArgs {
  readonly db: PostgresqlDatabase;
  readonly table: string;
  /**
   * Text hashed into the advisory lock every append takes for the duration of its transaction.
   */
  readonly lockKey: string;
}

export interface CreatePostgresqlEventStoreFunction {
  (args: CreatePostgresqlEventStoreArgs): EventStore;
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
  payload: row.payload,
  timestamp: String(row.timestamp),
  metadata: row.metadata as EventMetadata,
});

/**
 * Event store on one PostgreSQL table. Every append runs in a transaction that first takes
 * `pg_advisory_xact_lock(hashtext(lockKey))`: appends are serialised, so the `BIGSERIAL`
 * position matches commit order and `readAll` sees a gap-free global stream. Throughput is
 * bounded by that lock; it is plenty for the workloads Bounda targets.
 */
export const createPostgresqlEventStore: CreatePostgresqlEventStoreFunction = ({
  db,
  table,
  lockKey,
}) => {
  const currentVersion = async (
    executor: Pick<PostgresqlDatabase, "all">,
    aggregateType: string,
    aggregateId: string,
  ): Promise<number> => {
    const [row] = await executor.all(
      `SELECT COALESCE(MAX("version"), 0) AS "version" FROM ${table} WHERE "aggregate_type" = $1 AND "aggregate_id" = $2`,
      [aggregateType, aggregateId],
    );
    return Number(row?.version ?? 0);
  };

  return {
    append: ({ aggregateType, aggregateId, expectedVersion, events }) =>
      db.write(async (tx) => {
        await tx.run("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
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
            `INSERT INTO ${table} ("id", "aggregate_type", "aggregate_id", "version", "type", "payload", "timestamp", "metadata") VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING "position"`,
            [
              event.id,
              event.aggregateType,
              event.aggregateId,
              event.version,
              event.type,
              event.payload,
              event.timestamp,
              event.metadata,
            ],
          );
          stored.push({ ...event, position: Number(row?.position) });
        }
        return { version: actualVersion + stored.length, events: stored };
      }),
    load: async ({ aggregateType, aggregateId, fromVersion = 1 }) => {
      const rows = await db.all(
        `SELECT ${COLUMNS} FROM ${table} WHERE "aggregate_type" = $1 AND "aggregate_id" = $2 AND "version" >= $3 ORDER BY "version"`,
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
          `SELECT ${COLUMNS} FROM ${table} WHERE "position" > $1 ORDER BY "position" LIMIT $2`,
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
