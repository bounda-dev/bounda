import type { FindManyArgs, ReadClient, Table } from "../adapter/ports/table.ts";
import { sqliteDialect } from "../adapter/sql/dialect.ts";
import { codePointOrder } from "../adapter/sql/order.ts";
import { assertPage, columnFor } from "../adapter/sql/query-builder.ts";
import { type ColumnDefinition, columnsOf } from "../adapter/sql/read-model-schema.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import type { FieldsRecord } from "../modules/view.ts";

export interface CreateMemoryTableArgs {
  readonly name: string;
  readonly fields: FieldsRecord;
}

/**
 * A table held in memory whose `snapshot` returns what puts its rows back the way they were.
 */
export interface MemoryTable<Row> extends Table<Row> {
  snapshot(): () => void;
}

export interface CreateMemoryTableFunction {
  <Row extends object>(args: CreateMemoryTableArgs): MemoryTable<Row>;
}

type Stored = Readonly<Record<string, unknown>>;

// SQLite's order: no value first, text by code point.
const compare = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "string" && typeof b === "string") return codePointOrder(a, b);
  return (a as number) < (b as number) ? -1 : 1;
};

/**
 * A read-model table held in memory that behaves as the SQLite one: `where` compares dates and
 * JSON by value, `null` means no value, every read returns fresh copies, and the view, `unique()`,
 * required fields and limits are checked as SQLite checks them.
 */
export const createMemoryTable: CreateMemoryTableFunction = <Row extends object>({
  name,
  fields,
}: CreateMemoryTableArgs): MemoryTable<Row> => {
  const columns = columnsOf({ readModel: name, fields, dialect: sqliteDialect });
  const primaryKey = columns.find((column) => column.primaryKey) as ColumnDefinition;
  const rows = new Map<unknown, Stored>();

  const encode = (row: object): Stored =>
    Object.fromEntries(
      columns.map((column) => [
        column.field,
        sqliteDialect.encode(column.type, Reflect.get(row, column.field)),
      ]),
    );
  const decode = (stored: Stored): Row => {
    const row: Record<string, unknown> = {};
    for (const column of columns) {
      const value = sqliteDialect.decode(column.type, stored[column.field]);
      if (value !== undefined) row[column.field] = value;
    }
    return row as Row;
  };
  // Encoded once, and checked even when no row is there to compare, as SQL checks the statement.
  const matcher = (where: Partial<Row> | undefined): ((stored: Stored) => boolean) => {
    const expected = Object.entries(where ?? {}).map(([field, value]) => {
      const column = columnFor({ field, columns });
      return [column.field, sqliteDialect.encode(column.type, value)] as const;
    });
    return (stored) => expected.every(([field, value]) => stored[field] === value);
  };
  const violated = (kind: "NOT NULL" | "UNIQUE", column: ColumnDefinition): Error =>
    new Error(`${kind} constraint failed: ${name}.${column.field}`);
  const checkRequired = (stored: Stored): void => {
    const missing = columns.find((column) => !column.nullable && stored[column.field] === null);
    if (missing !== undefined) throw violated("NOT NULL", missing);
  };
  // The primary key is unique by the map's own keys; `update` checks it when a row is re-keyed.
  const checkUnique = (key: unknown, stored: Stored, table: ReadonlyMap<unknown, Stored>): void => {
    for (const column of columns) {
      const value = stored[column.field];
      if (!column.unique || column.primaryKey || value === null) continue;
      for (const [other, row] of table) {
        if (other !== key && row[column.field] === value) throw violated("UNIQUE", column);
      }
    }
  };
  const write = (stored: Stored): void => {
    const key = stored[primaryKey.field];
    checkRequired(stored);
    checkUnique(key, stored, rows);
    rows.set(key, stored);
  };

  const select = (args: FindManyArgs<Row> = {}): Row[] => {
    assertPage(args);
    const selected = [...rows.values()].filter(matcher(args.where));
    if (args.orderBy !== undefined) {
      const { field, direction } = args.orderBy;
      const column = columnFor({ field, columns });
      selected.sort(
        (a, b) => compare(a[column.field], b[column.field]) * (direction === "asc" ? 1 : -1),
      );
    }
    const offset = args.offset ?? 0;
    return selected
      .slice(offset, args.limit === undefined ? undefined : offset + args.limit)
      .map(decode);
  };

  return {
    upsert: async (row) => write(encode(row)),
    insert: async (row) => {
      const stored = encode(row);
      if (!rows.has(stored[primaryKey.field])) write(stored);
      else checkRequired(stored);
    },
    update: async (where, patch) => {
      const changes = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (changes.length === 0) return;
      const encoded = Object.fromEntries(
        changes.map(([field, value]) => {
          const column = columnFor({ field, columns });
          return [column.field, sqliteDialect.encode(column.type, value)];
        }),
      );
      const matches = matcher(where);
      // Built aside and checked whole, so a refused update changes nothing, as one statement; a
      // row keeps its place, as it keeps its rowid.
      const next = new Map<unknown, Stored>();
      const changed: Stored[] = [];
      for (const row of rows.values()) {
        const updated = matches(row) ? { ...row, ...encoded } : row;
        if (updated !== row) {
          checkRequired(updated);
          changed.push(updated);
        }
        const key = updated[primaryKey.field];
        if (next.has(key)) throw violated("UNIQUE", primaryKey);
        next.set(key, updated);
      }
      if (changed.length === 0) return;
      for (const updated of changed) checkUnique(updated[primaryKey.field], updated, next);
      rows.clear();
      for (const [key, row] of next) rows.set(key, row);
    },
    delete: async (where) => {
      const matches = matcher(where);
      for (const [key, row] of rows) {
        if (matches(row)) rows.delete(key);
      }
    },
    findOne: async (where) => select({ where, limit: 1 })[0] ?? null,
    findMany: async (args) => select(args),
    count: async (where) => [...rows.values()].filter(matcher(where)).length,
    snapshot: () => {
      const saved = new Map(rows);
      return () => {
        rows.clear();
        for (const [key, row] of saved) rows.set(key, row);
      };
    },
  };
};

export interface CreateMemoryReadClientFunction {
  <Row extends object>(args: {
    readonly name: string;
    readonly table: Table<Row>;
  }): ReadClient<Row, Table<Row>>;
}

/**
 * The read client of the in-memory adapter. It runs no SQL: queries against the in-memory adapter
 * use `table`. `raw` is the table itself.
 */
export const createMemoryReadClient: CreateMemoryReadClientFunction = <Row extends object>({
  name,
  table,
}: {
  readonly name: string;
  readonly table: Table<Row>;
}): ReadClient<Row, Table<Row>> => {
  const unsupported = (): never => {
    throw new ConfigurationError(
      `Read model "${name}" uses the in-memory adapter, which runs no SQL. Use table.findOne / table.findMany in the repository, or configure a SQL adapter.`,
    );
  };
  return { get: async () => unsupported(), all: async () => unsupported(), raw: table };
};
