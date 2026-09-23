import type { FindManyArgs, ReadClient, Table } from "../adapter/ports/table.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import type { FieldsRecord } from "../modules/view.ts";

export interface CreateMemoryTableArgs {
  readonly name: string;
  readonly fields: FieldsRecord;
}

/**
 * A table held in memory that can take a snapshot of its rows: `snapshot` returns what puts them
 * back the way they were, which is how the in-memory adapter rolls a transaction back.
 */
export interface MemoryTable<Row> extends Table<Row> {
  snapshot(): () => void;
}

export interface CreateMemoryTableFunction {
  <Row extends object>(args: CreateMemoryTableArgs): MemoryTable<Row>;
}

const primaryKeyOf = (name: string, fields: FieldsRecord): string => {
  const key = Object.entries(fields).find(([, field]) => field.isPrimaryKey)?.[0];
  if (key === undefined) {
    throw new ConfigurationError(`Read model "${name}" declares no primary key field`);
  }
  return key;
};

const matches = <Row>(row: Row, where: Partial<Row> | undefined): boolean =>
  where === undefined ||
  Object.entries(where).every(([field, value]) =>
    Object.is(Reflect.get(row as object, field), value),
  );

const compare = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return (a as number) < (b as number) ? -1 : 1;
};

const withoutUndefined = <Row extends object>(row: Row): Row =>
  Object.fromEntries(
    Object.entries(row as Record<string, unknown>).filter(([, value]) => value !== undefined),
  ) as Row;

/**
 * A read-model table held in memory. Rows are keyed by the field marked `primaryKey()`.
 */
export const createMemoryTable: CreateMemoryTableFunction = <Row extends object>({
  name,
  fields,
}: CreateMemoryTableArgs): MemoryTable<Row> => {
  const primaryKey = primaryKeyOf(name, fields);
  const rows = new Map<unknown, Row>();
  const keyOf = (row: Partial<Row>): unknown => Reflect.get(row, primaryKey);

  const select = (args: FindManyArgs<Row> = {}): Row[] => {
    const selected = [...rows.values()].filter((row) => matches(row, args.where));
    if (args.orderBy !== undefined) {
      const { field, direction } = args.orderBy;
      selected.sort(
        (a, b) =>
          compare(Reflect.get(a, field), Reflect.get(b, field)) * (direction === "asc" ? 1 : -1),
      );
    }
    const offset = args.offset ?? 0;
    return selected.slice(offset, args.limit === undefined ? undefined : offset + args.limit);
  };

  return {
    upsert: async (row) => {
      rows.set(keyOf(row), withoutUndefined(row));
    },
    insert: async (row) => {
      const key = keyOf(row);
      if (!rows.has(key)) rows.set(key, withoutUndefined(row));
    },
    update: async (where, patch) => {
      for (const [key, row] of rows) {
        if (matches(row, where)) rows.set(key, withoutUndefined({ ...row, ...patch }));
      }
    },
    delete: async (where) => {
      for (const [key, row] of rows) {
        if (matches(row, where)) rows.delete(key);
      }
    },
    findOne: async (where) => select({ where, limit: 1 })[0] ?? null,
    findMany: async (args) => select(args),
    count: async (where) => select({ ...(where === undefined ? {} : { where }) }).length,
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
