import type { PendingEvent, StoredEventType } from "../storage/event-store.ts";
import type { SqlDialect } from "./dialect.ts";
import type { InsertStatement } from "./event-rows.ts";

/**
 * The event types a store knows its catalogue holds, so an append writes a row only for a type
 * it has not met. A type counts once the transaction that wrote it committed: one marked inside a
 * transaction that rolls back would never be written again.
 */
export interface KnownEventTypes {
  /**
   * The types of `events` not known yet, each once.
   */
  unseen(events: readonly PendingEvent[]): readonly StoredEventType[];
  /**
   * Called by a store once its own write of `types` resolved.
   */
  recorded(types: readonly StoredEventType[]): void;
}

/**
 * Known types for the stores of one transaction: what they record counts for everyone only once
 * `commit` is called, after the transaction committed.
 */
export interface PendingEventTypes extends KnownEventTypes {
  commit(): void;
}

/**
 * The known types of one storage: its own stores record straight into them, the stores of each
 * transaction through `pending()`.
 */
export interface SharedEventTypes extends KnownEventTypes {
  pending(): PendingEventTypes;
}

export interface CreateKnownEventTypesFunction {
  (): SharedEventTypes;
}

const keyOf = ({ aggregateType, type, schemaVersion }: StoredEventType): string =>
  JSON.stringify([aggregateType, type, schemaVersion]);

const typesOf = (
  events: readonly PendingEvent[],
  known: ReadonlySet<string>,
): readonly StoredEventType[] => {
  const found = new Map<string, StoredEventType>();
  for (const { aggregateType, type, metadata } of events) {
    const eventType = { aggregateType, type, schemaVersion: metadata.schemaVersion };
    const key = keyOf(eventType);
    if (!known.has(key)) found.set(key, eventType);
  }
  return [...found.values()];
};

/**
 * Known types for one storage, none at first: `types()` fills them, so a booted app's appends
 * record nothing for the types the store already holds.
 */
export const createKnownEventTypes: CreateKnownEventTypesFunction = () => {
  const keys = new Set<string>();
  const recorded = (types: readonly StoredEventType[]): void => {
    for (const eventType of types) keys.add(keyOf(eventType));
  };
  return {
    unseen: (events) => typesOf(events, keys),
    recorded,
    pending: () => {
      const held: StoredEventType[] = [];
      return {
        unseen: (events) => typesOf(events, keys),
        recorded: (types) => {
          held.push(...types);
        },
        commit: () => recorded(held.splice(0)),
      };
    },
  };
};

export interface InsertEventTypesArgs {
  readonly dialect: Pick<SqlDialect, "placeholder">;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly types: readonly StoredEventType[];
}

export interface InsertEventTypesFunction {
  (args: InsertEventTypesArgs): readonly InsertStatement[];
}

const PARAMETERS_PER_TYPE = 3;

// The Durable Object's SQLite binds at most a hundred parameters to a statement.
const TYPES_PER_INSERT = Math.floor(100 / PARAMETERS_PER_TYPE);

/**
 * The statements that record `types` in the catalogue, leaving a type already there as it is, so
 * two writers recording the same one never conflict.
 */
export const insertEventTypesStatements: InsertEventTypesFunction = ({ dialect, table, types }) => {
  const statements: InsertStatement[] = [];
  for (let start = 0; start < types.length; start += TYPES_PER_INSERT) {
    const slice = types.slice(start, start + TYPES_PER_INSERT);
    const params = slice.flatMap(({ aggregateType, type, schemaVersion }) => [
      aggregateType,
      type,
      schemaVersion,
    ]);
    const rows = slice.map((_, row) => {
      const first = row * PARAMETERS_PER_TYPE + 1;
      return `(${Array.from({ length: PARAMETERS_PER_TYPE }, (_, index) => dialect.placeholder(first + index)).join(", ")})`;
    });
    statements.push({
      sql: `INSERT INTO ${table} ("aggregate_type", "type", "schema_version") VALUES ${rows.join(", ")} ON CONFLICT DO NOTHING`,
      params,
    });
  }
  return statements;
};

export interface SelectEventTypesFunction {
  (table: string): string;
}

/**
 * The statement that reads every type of the catalogue, each a row `eventTypeOfRow` decodes.
 */
export const selectEventTypesStatement: SelectEventTypesFunction = (table) =>
  `SELECT "aggregate_type", "type", "schema_version" FROM ${table}`;

export interface EventTypeOfRowFunction {
  (row: Record<string, unknown>): StoredEventType;
}

/**
 * A type as `selectEventTypesStatement` reads it.
 */
export const eventTypeOfRow: EventTypeOfRowFunction = (row) => ({
  aggregateType: String(row.aggregate_type),
  type: String(row.type),
  schemaVersion: Number(row.schema_version),
});
