import { ConcurrencyError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { EventMetadata } from "../../contracts/metadata.ts";
import type { EventStore } from "../index.ts";
import { checkSqlAppend } from "../sql/append-checks.ts";
import type { SqlDatabase } from "../sql/database.ts";
import { sqliteDialect } from "../sql/dialect.ts";
import { insertEventsStatements, positionsByVersion } from "../sql/event-rows.ts";

export interface CreateSqliteEventStoreArgs {
  readonly db: SqlDatabase;
  readonly table: string;
  /**
   * The key and restriction tables an append checks the persons it names against.
   */
  readonly personalKeys: string;
  readonly restrictions: string;
}

export interface CreateSqliteEventStoreFunction {
  (args: CreateSqliteEventStoreArgs): EventStore;
}

const COLUMNS =
  '"position", "id", "aggregate_type", "aggregate_id", "version", "type", "payload", "timestamp", "metadata", "person"';

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
  person: row.person === null ? null : String(row.person),
});

export const createSqliteEventStore: CreateSqliteEventStoreFunction = ({
  db,
  table,
  personalKeys,
  restrictions,
}) => {
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
    // The single writer orders a `forget` or `restrict` before the check or after the write.
    append: (args) =>
      db.write(async (tx) => {
        const { aggregateType, aggregateId, expectedVersion, events } = args;
        const actualVersion = await currentVersion(tx, aggregateType, aggregateId);
        if (actualVersion !== expectedVersion) {
          throw new ConcurrencyError({
            streamId: `${aggregateType}:${aggregateId}`,
            expectedVersion,
            actualVersion,
          });
        }
        await checkSqlAppend({
          tx,
          dialect: sqliteDialect,
          tables: { personalKeys, restrictions },
          args,
        });
        const rows: Record<string, unknown>[] = [];
        for (const { sql, params } of insertEventsStatements({
          dialect: sqliteDialect,
          table,
          events,
          encodeJson: (value) => JSON.stringify(value),
        })) {
          rows.push(...(await tx.all(sql, params)));
        }
        const positions = positionsByVersion(rows);
        const stored = events.map((event) => ({
          ...event,
          position: positions.get(event.version) as number,
        }));
        return { version: actualVersion + stored.length, events: stored };
      }),
    // A load from the first event reads one statement, whose last row is the head. From later
    // on, the head is read first and the events bounded by it: outside a transaction, an append
    // landing between the two reads would otherwise report a head past the events returned.
    load: async ({ aggregateType, aggregateId, fromVersion = 1 }) => {
      if (fromVersion <= 1) {
        const rows = await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE "aggregate_type" = ? AND "aggregate_id" = ? ORDER BY "version"`,
          [aggregateType, aggregateId],
        );
        const events = rows.map(toStoredEvent);
        return { events, version: events.at(-1)?.version ?? 0 };
      }
      const version = await currentVersion(db, aggregateType, aggregateId);
      const rows =
        version < fromVersion
          ? []
          : await db.all(
              `SELECT ${COLUMNS} FROM ${table} WHERE "aggregate_type" = ? AND "aggregate_id" = ? AND "version" >= ? AND "version" <= ? ORDER BY "version"`,
              [aggregateType, aggregateId, fromVersion, version],
            );
      return { events: rows.map(toStoredEvent), version };
    },
    readOne: async ({ aggregateType, aggregateId, eventId }) => {
      const [row] = await db.all(
        `SELECT ${COLUMNS} FROM ${table} WHERE "id" = ? AND "aggregate_type" = ? AND "aggregate_id" = ?`,
        [eventId, aggregateType, aggregateId],
      );
      return row === undefined ? null : toStoredEvent(row);
    },
    readAll: async ({ afterPosition, limit }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE "position" > ? ORDER BY "position" LIMIT ?`,
          [afterPosition, limit],
        )
      ).map(toStoredEvent),
    readByPerson: async ({ person, afterPosition, limit }) =>
      (
        await db.all(
          `SELECT ${COLUMNS} FROM ${table} WHERE "person" = ? AND "position" > ? ORDER BY "position" LIMIT ?`,
          [person, afterPosition, limit],
        )
      ).map(toStoredEvent),
    lastPosition: async () => {
      const [row] = await db.all(
        `SELECT COALESCE(MAX("position"), 0) AS "position" FROM ${table}`,
        [],
      );
      return Number(row?.position ?? 0);
    },
    reseal: (events) =>
      db.write(async (tx) => {
        for (const { position, payload, person } of events) {
          await tx.run(`UPDATE ${table} SET "payload" = ?, "person" = ? WHERE "position" = ?`, [
            JSON.stringify(payload),
            person,
            position,
          ]);
        }
      }),
  };
};
