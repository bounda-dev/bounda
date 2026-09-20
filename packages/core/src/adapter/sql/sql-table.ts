import type { FieldsRecord } from "../../modules/view.ts";
import type { ReadClient, Table } from "../ports/table.ts";
import type { SqlDialect } from "./dialect.ts";
import { fromSnakeCase, quoteIdentifier } from "./identifiers.ts";
import { buildLimit, buildOrderBy, buildWhere, columnFor } from "./query-builder.ts";
import { type ColumnDefinition, columnsOf } from "./read-model-schema.ts";

/**
 * The two calls a SQL table needs from a driver. Adapters implement it over their client; the
 * statements arrive with the dialect's placeholders and already encoded parameters.
 */
export interface SqlExecutor {
  run(sql: string, params: readonly unknown[]): Promise<void>;
  all(sql: string, params: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

export interface DecodeRowArgs {
  readonly row: Readonly<Record<string, unknown>>;
  readonly columns: readonly ColumnDefinition[];
  readonly dialect: SqlDialect;
}

export interface DecodeRowFunction {
  <Row extends object>(args: DecodeRowArgs): Row;
}

/**
 * Turns a driver row into a read-model row: column names back to camelCase, values decoded by
 * field type, `NULL` left out. Columns the view does not declare (aliases in hand-written SQL)
 * pass through unchanged, camelCased.
 */
export const decodeRow: DecodeRowFunction = <Row extends object>({
  row,
  columns,
  dialect,
}: DecodeRowArgs): Row => {
  const byName = new Map(columns.map((column) => [column.name, column]));
  const decoded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    const column = byName.get(name);
    if (column === undefined) {
      decoded[fromSnakeCase(name)] = value;
      continue;
    }
    const fieldValue = dialect.decode(column.type, value);
    if (fieldValue !== undefined) decoded[column.field] = fieldValue;
  }
  return decoded as Row;
};

export interface CreateSqlTableArgs {
  readonly readModel: string;
  readonly table: string;
  readonly fields: FieldsRecord;
  readonly dialect: SqlDialect;
  readonly executor: SqlExecutor;
}

export interface CreateSqlTableFunction {
  <Row extends object>(args: CreateSqlTableArgs): Table<Row>;
}

/**
 * `Table<Row>` over any SQL engine: idempotent writes through `ON CONFLICT`, reads with
 * allow-listed columns only. SQLite and PostgreSQL adapters supply the dialect and an executor.
 */
export const createSqlTable: CreateSqlTableFunction = <Row extends object>({
  readModel,
  table,
  fields,
  dialect,
  executor,
}: CreateSqlTableArgs): Table<Row> => {
  const columns = columnsOf({ readModel, fields, dialect });
  const primaryKey = columns.find((column) => column.primaryKey) as ColumnDefinition;
  const target = quoteIdentifier(table);
  const columnList = columns.map((column) => quoteIdentifier(column.name)).join(", ");

  const encodeRow = (row: Partial<Row>): unknown[] =>
    columns.map((column) => dialect.encode(column.type, Reflect.get(row, column.field)));

  const placeholders = (count: number, offset = 0): string =>
    Array.from({ length: count }, (_, index) => dialect.placeholder(offset + index + 1)).join(", ");

  const insert = (row: Row, onConflict: string): Promise<void> =>
    executor.run(
      `INSERT INTO ${target} (${columnList}) VALUES (${placeholders(columns.length)}) ON CONFLICT (${quoteIdentifier(primaryKey.name)}) ${onConflict}`,
      encodeRow(row),
    );

  const upsertClause = (): string => {
    const updates = columns
      .filter((column) => !column.primaryKey)
      .map(
        (column) => `${quoteIdentifier(column.name)} = excluded.${quoteIdentifier(column.name)}`,
      );
    return updates.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${updates.join(", ")}`;
  };

  const select = async (args: {
    readonly where?: Partial<Row>;
    readonly orderBy?: { readonly field: keyof Row & string; readonly direction: "asc" | "desc" };
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<readonly Row[]> => {
    const where = buildWhere({ where: args.where, columns, dialect });
    const order = buildOrderBy({ orderBy: args.orderBy, columns });
    const limit = buildLimit({
      limit: args.limit,
      offset: args.offset,
      dialect,
      paramOffset: where.params.length,
    });
    const rows = await executor.all(
      `SELECT ${columnList} FROM ${target}${where.sql}${order}${limit.sql}`,
      [...where.params, ...limit.params],
    );
    return rows.map((row) => decodeRow<Row>({ row, columns, dialect }));
  };

  return {
    upsert: (row) => insert(row, upsertClause()),
    insert: (row) => insert(row, "DO NOTHING"),
    update: async (where, patch) => {
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length === 0) return;
      const params: unknown[] = [];
      const assignments = entries.map(([field, value]) => {
        const column = columnFor({ field, columns });
        params.push(dialect.encode(column.type, value));
        return `${quoteIdentifier(column.name)} = ${dialect.placeholder(params.length)}`;
      });
      const clause = buildWhere({ where, columns, dialect, offset: params.length });
      await executor.run(`UPDATE ${target} SET ${assignments.join(", ")}${clause.sql}`, [
        ...params,
        ...clause.params,
      ]);
    },
    delete: async (where) => {
      const clause = buildWhere({ where, columns, dialect });
      await executor.run(`DELETE FROM ${target}${clause.sql}`, clause.params);
    },
    findOne: async (where) => (await select({ where, limit: 1 }))[0] ?? null,
    findMany: (args = {}) => select(args),
    count: async (where) => {
      const clause = buildWhere({ where, columns, dialect });
      const [row] = await executor.all(
        `SELECT COUNT(*) AS count FROM ${target}${clause.sql}`,
        clause.params,
      );
      return Number(row?.count ?? 0);
    },
  };
};

export interface CreateSqlReadClientArgs<Raw> {
  readonly readModel: string;
  readonly fields: FieldsRecord;
  readonly dialect: SqlDialect;
  readonly executor: SqlExecutor;
  readonly raw: Raw;
}

export interface CreateSqlReadClientFunction {
  <Row extends object, Raw>(args: CreateSqlReadClientArgs<Raw>): ReadClient<Row, Raw>;
}

/**
 * `ReadClient` for hand-written SQL: rows come back decoded like the table's, `raw` is the driver.
 */
export const createSqlReadClient: CreateSqlReadClientFunction = <Row extends object, Raw>({
  readModel,
  fields,
  dialect,
  executor,
  raw,
}: CreateSqlReadClientArgs<Raw>): ReadClient<Row, Raw> => {
  const columns = columnsOf({ readModel, fields, dialect });
  const all = async (sql: string, params: readonly unknown[] = []): Promise<readonly Row[]> =>
    (await executor.all(sql, params)).map((row) => decodeRow<Row>({ row, columns, dialect }));
  return {
    get: async (sql, params) => (await all(sql, params))[0] ?? null,
    all,
    raw,
  };
};
