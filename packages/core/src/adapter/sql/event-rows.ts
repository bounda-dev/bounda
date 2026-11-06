import type { PendingEvent } from "../storage/event-store.ts";
import type { SqlDialect } from "./dialect.ts";

export interface InsertEventsArgs {
  readonly dialect: Pick<SqlDialect, "placeholder">;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly events: readonly PendingEvent[];
  /**
   * How the engine takes a JSON column: text for SQLite, a `jsonb` parameter for PostgreSQL.
   */
  readonly encodeJson: (value: unknown) => unknown;
}

export interface InsertStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface InsertEventsFunction {
  (args: InsertEventsArgs): readonly InsertStatement[];
}

const EVENT_COLUMNS =
  '"id", "aggregate_type", "aggregate_id", "version", "type", "payload", "timestamp", "metadata"';
const PARAMETERS_PER_EVENT = 8;

/**
 * Events one `INSERT` carries: the Durable Object's SQLite binds at most a hundred parameters to
 * a statement, and the others take far more.
 */
export const EVENTS_PER_INSERT: number = 12;

/**
 * The statements that append `events` as rows, as few as the engines allow, each answering the
 * `"version"` and `"position"` of every row it wrote; `RETURNING` hands rows back in no fixed
 * order, so the caller matches positions to events by version.
 */
export const insertEventsStatements: InsertEventsFunction = ({
  dialect,
  table,
  events,
  encodeJson,
}) => {
  const statements: InsertStatement[] = [];
  for (let start = 0; start < events.length; start += EVENTS_PER_INSERT) {
    const slice = events.slice(start, start + EVENTS_PER_INSERT);
    const params: unknown[] = [];
    const rows = slice.map((event, row) => {
      params.push(
        event.id,
        event.aggregateType,
        event.aggregateId,
        event.version,
        event.type,
        encodeJson(event.payload),
        event.timestamp,
        encodeJson(event.metadata),
      );
      const first = row * PARAMETERS_PER_EVENT + 1;
      return `(${Array.from({ length: PARAMETERS_PER_EVENT }, (_, index) => dialect.placeholder(first + index)).join(", ")})`;
    });
    statements.push({
      sql: `INSERT INTO ${table} (${EVENT_COLUMNS}) VALUES ${rows.join(", ")} RETURNING "version", "position"`,
      params,
    });
  }
  return statements;
};

export interface PositionsByVersionFunction {
  (rows: readonly Record<string, unknown>[]): ReadonlyMap<number, number>;
}

export const positionsByVersion: PositionsByVersionFunction = (rows) =>
  new Map(rows.map((row) => [Number(row.version), Number(row.position)]));
