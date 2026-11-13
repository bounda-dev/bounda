import type { FieldsRecord } from "../../modules/view.ts";
import type { UnsettledRowsArgs } from "../storage/sealed-fields.ts";
import { ENVELOPE_PREFIX } from "../storage/sealed-fields.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier } from "./identifiers.ts";
import { columnFor } from "./query-builder.ts";
import { type ColumnDefinition, columnsOf } from "./read-model-schema.ts";
import { decodeRow, type SqlExecutor } from "./sql-table.ts";

export interface SelectUnsettledArgs extends UnsettledRowsArgs {
  readonly readModel: string;
  /**
   * The table, unquoted: the read model's, or its rebuild's shadow.
   */
  readonly table: string;
  readonly fields: FieldsRecord;
  readonly dialect: SqlDialect;
  readonly executor: SqlExecutor;
}

export interface SelectUnsettledFunction {
  (args: SelectUnsettledArgs): Promise<readonly Record<string, unknown>[]>;
}

/**
 * The rows `ReadModelTransaction.unsettled` answers, on the SQL SQLite and PostgreSQL both speak.
 */
export const selectUnsettled: SelectUnsettledFunction = async ({
  readModel,
  table,
  fields,
  dialect,
  executor,
  sealed,
  keyed,
  limit,
}) => {
  if (sealed.length === 0 && keyed.length === 0) return [];
  const columns = columnsOf({ readModel, fields, dialect });
  const column = (field: string): string => quoteIdentifier(columnFor({ field, columns }).name);
  // One parameter per use: SQLite's placeholders are positional.
  const params: unknown[] = [];
  const prefix = (): string => {
    params.push(ENVELOPE_PREFIX);
    return dialect.placeholder(params.length);
  };
  const conditions = [
    ...sealed.map(
      (field) =>
        `(${column(field)} IS NOT NULL AND substr(${column(field)}, 1, ${ENVELOPE_PREFIX.length}) <> ${prefix()})`,
    ),
    ...keyed.map(
      ({ field, keyField }) => `(${column(field)} IS NOT NULL AND ${column(keyField)} IS NULL)`,
    ),
  ];
  params.push(limit);
  const rows = await executor.all(
    `SELECT ${columns.map((c: ColumnDefinition) => quoteIdentifier(c.name)).join(", ")} FROM ${quoteIdentifier(table)} WHERE ${conditions.join(" OR ")} LIMIT ${dialect.placeholder(params.length)}`,
    params,
  );
  return rows.map((row) => decodeRow({ row, columns, dialect }));
};
