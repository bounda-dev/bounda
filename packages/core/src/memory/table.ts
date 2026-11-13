import { sqliteDialect } from "../adapter/sql/dialect.ts";
import { codePointOrder } from "../adapter/sql/order.ts";
import {
  assertPage,
  columnFor,
  conditionsOf,
  type RangeOperator,
} from "../adapter/sql/query-builder.ts";
import { type ColumnDefinition, columnsOf } from "../adapter/sql/read-model-schema.ts";
import { ENVELOPE_PREFIX, type UnsettledRowsArgs } from "../adapter/storage/sealed-fields.ts";
import type { FindManyArgs, StoredReadClient, Table, Where } from "../adapter/storage/table.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import type { FieldsRecord } from "../modules/view.ts";

export interface CreateMemoryTableArgs {
  readonly name: string;
  readonly fields: FieldsRecord;
}

export interface MemoryTable<Row> extends Table<Row> {
  // Returns what puts the rows back the way they were.
  snapshot(): () => void;
  /**
   * Every row as kept, encoded as the SQLite table would hold it.
   */
  rows(): readonly Readonly<Record<string, unknown>>[];
  /**
   * The field of its primary key.
   */
  readonly key: string;
  /**
   * The table, its reads leaving out the rows `keep` refuses before a page is cut or counted, as a
   * condition in SQL would; its writes are the table's.
   */
  keeping(keep: (row: Readonly<Record<string, unknown>>) => boolean): Table<Row>;
  unsettled(args: UnsettledRowsArgs): Promise<readonly Row[]>;
}

export interface CreateMemoryTableFunction {
  <Row extends object>(args: CreateMemoryTableArgs): MemoryTable<Row>;
}

type Stored = Readonly<Record<string, unknown>>;

export interface CompareStoredFunction {
  (a: unknown, b: unknown): number;
}

// SQLite's order: no value first, text by code point.
export const compareStored: CompareStoredFunction = (a, b) => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "string" && typeof b === "string") return codePointOrder(a, b);
  return (a as number) < (b as number) ? -1 : 1;
};

const RANGES: Readonly<Record<RangeOperator, (order: number) => boolean>> = {
  gt: (order) => order > 0,
  gte: (order) => order >= 0,
  lt: (order) => order < 0,
  lte: (order) => order <= 0,
};

// Behaves as the SQLite table, checks included: the table contract runs against both.
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
  // A range holds for no row without a value, as in SQL; `ne` compares as `IS NOT` does.
  const matcher = (where: Where<Row> | undefined): ((stored: Stored) => boolean) => {
    const tests = conditionsOf({ where, columns }).map(
      (condition): ((stored: Stored) => boolean) => {
        const { field, type } = condition.column;
        if (condition.operator === "in") {
          const values = condition.values.map((value) => sqliteDialect.encode(type, value));
          return (stored) => values.includes(stored[field]);
        }
        const value = sqliteDialect.encode(type, condition.value);
        switch (condition.operator) {
          case "eq":
            return (stored) => stored[field] === value;
          case "ne":
            return (stored) => stored[field] !== value;
          default: {
            const holds = RANGES[condition.operator];
            return (stored) => stored[field] !== null && holds(compareStored(stored[field], value));
          }
        }
      },
    );
    return (stored) => tests.every((test) => test(stored));
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

  const select = (
    args: FindManyArgs<Row> = {},
    keep: (stored: Stored) => boolean = () => true,
  ): Row[] => {
    assertPage(args);
    const matches = matcher(args.where);
    const selected = [...rows.values()].filter((stored) => matches(stored) && keep(stored));
    if (args.orderBy !== undefined) {
      const { field, direction } = args.orderBy;
      const column = columnFor({ field, columns });
      selected.sort(
        (a, b) => compareStored(a[column.field], b[column.field]) * (direction === "asc" ? 1 : -1),
      );
    }
    const offset = args.offset ?? 0;
    return selected
      .slice(offset, args.limit === undefined ? undefined : offset + args.limit)
      .map(decode);
  };

  const table: MemoryTable<Row> = {
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
    rows: () => [...rows.values()],
    unsettled: async ({ sealed, keyed, limit }) =>
      [...rows.values()]
        .filter(
          (stored) =>
            sealed.some((field) => {
              const value = stored[field];
              return typeof value === "string" && !value.startsWith(ENVELOPE_PREFIX);
            }) ||
            keyed.some(
              ({ field, keyField }) => stored[field] !== null && stored[keyField] === null,
            ),
        )
        .slice(0, limit)
        .map(decode),
    key: primaryKey.field,
    snapshot: () => {
      const saved = new Map(rows);
      return () => {
        rows.clear();
        for (const [key, row] of saved) rows.set(key, row);
      };
    },
    keeping: (keep) => ({
      ...table,
      findOne: async (where) => select({ where, limit: 1 }, keep)[0] ?? null,
      findMany: async (args) => select(args, keep),
      count: async (where) => {
        const matches = matcher(where);
        return [...rows.values()].filter((stored) => matches(stored) && keep(stored)).length;
      },
    }),
  };
  return table;
};

export interface CreateMemoryReadClientFunction {
  <Row extends object>(args: {
    readonly name: string;
    readonly table: Table<Row>;
  }): StoredReadClient<Row, Table<Row>>;
}

export const createMemoryReadClient: CreateMemoryReadClientFunction = <Row extends object>({
  name,
  table,
}: {
  readonly name: string;
  readonly table: Table<Row>;
}): StoredReadClient<Row, Table<Row>> => {
  const unsupported = (): never => {
    throw new ConfigurationError(
      `Read model "${name}" uses the in-memory adapter, which runs no SQL. Use table.findOne / table.findMany in the repository, or configure a SQL adapter.`,
    );
  };
  return { get: async () => unsupported(), all: async () => unsupported(), raw: table };
};
