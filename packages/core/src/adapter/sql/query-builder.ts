import { ConfigurationError } from "../../contracts/errors.ts";
import type { TableOrder } from "../ports/table.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier } from "./identifiers.ts";
import type { ColumnDefinition } from "./read-model-schema.ts";

/**
 * A piece of SQL and the parameters it binds, in order.
 */
export interface SqlFragment {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface ColumnForArgs {
  readonly field: string;
  readonly columns: readonly ColumnDefinition[];
}

export interface ColumnForFunction {
  (args: ColumnForArgs): ColumnDefinition;
}

/**
 * The column of a field, or a `ConfigurationError` when the read model has no such field. Every
 * name that reaches SQL passes through here, so `where` and `orderBy` can only name real columns.
 */
export const columnFor: ColumnForFunction = ({ field, columns }) => {
  const column = columns.find((candidate) => candidate.field === field);
  if (column === undefined) {
    throw new ConfigurationError(
      `Unknown field "${field}"; the read model has: ${columns.map((c) => c.field).join(", ")}`,
    );
  }
  return column;
};

export interface BuildWhereArgs {
  readonly where: Readonly<Record<string, unknown>> | undefined;
  readonly columns: readonly ColumnDefinition[];
  readonly dialect: SqlDialect;
  /**
   * How many parameters precede this fragment in the statement, for `$n` placeholders.
   */
  readonly offset?: number;
}

export interface BuildWhereFunction {
  (args: BuildWhereArgs): SqlFragment;
}

/**
 * ` WHERE "a" = $1 AND "b" IS NULL` from a `Partial<Row>`; empty when there is nothing to match.
 * `undefined` and `null` both match rows without a value, as the in-memory table does.
 */
export const buildWhere: BuildWhereFunction = ({ where, columns, dialect, offset = 0 }) => {
  const entries = Object.entries(where ?? {});
  if (entries.length === 0) return { sql: "", params: [] };
  const params: unknown[] = [];
  const clauses = entries.map(([field, value]) => {
    const column = columnFor({ field, columns });
    if (value === undefined || value === null) return `${quoteIdentifier(column.name)} IS NULL`;
    params.push(dialect.encode(column.type, value));
    return `${quoteIdentifier(column.name)} = ${dialect.placeholder(offset + params.length)}`;
  });
  return { sql: ` WHERE ${clauses.join(" AND ")}`, params };
};

export interface BuildOrderByArgs {
  readonly orderBy: TableOrder<Record<string, unknown>> | undefined;
  readonly columns: readonly ColumnDefinition[];
}

export interface BuildOrderByFunction {
  (args: BuildOrderByArgs): string;
}

/**
 * ` ORDER BY "total" DESC`, or empty.
 */
export const buildOrderBy: BuildOrderByFunction = ({ orderBy, columns }) => {
  if (orderBy === undefined) return "";
  const column = columnFor({ field: orderBy.field, columns });
  return ` ORDER BY ${quoteIdentifier(column.name)} ${orderBy.direction === "desc" ? "DESC" : "ASC"}`;
};

export interface BuildLimitArgs {
  readonly limit: number | undefined;
  readonly offset: number | undefined;
  readonly dialect: SqlDialect;
  /**
   * How many parameters precede this fragment in the statement.
   */
  readonly paramOffset: number;
}

export interface BuildLimitFunction {
  (args: BuildLimitArgs): SqlFragment;
}

const assertCount = (value: number, subject: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(`${subject} must be a non-negative integer, got ${value}`);
  }
  return value;
};

/**
 * ` LIMIT $1 OFFSET $2` as parameters. SQLite needs a `LIMIT` before an `OFFSET`, so an offset
 * alone gets `LIMIT -1` there.
 */
export const buildLimit: BuildLimitFunction = ({ limit, offset, dialect, paramOffset }) => {
  if (limit === undefined && offset === undefined) return { sql: "", params: [] };
  const params: unknown[] = [];
  const parts: string[] = [];
  const effectiveLimit = limit ?? (dialect.name === "sqlite" ? -1 : undefined);
  if (effectiveLimit !== undefined) {
    params.push(limit === undefined ? effectiveLimit : assertCount(limit, "limit"));
    parts.push(`LIMIT ${dialect.placeholder(paramOffset + params.length)}`);
  }
  if (offset !== undefined) {
    params.push(assertCount(offset, "offset"));
    parts.push(`OFFSET ${dialect.placeholder(paramOffset + params.length)}`);
  }
  return { sql: ` ${parts.join(" ")}`, params };
};
