import { ConfigurationError } from "../../contracts/errors.ts";
import type { TableOrder } from "../storage/table.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier } from "./identifiers.ts";
import type { ColumnDefinition } from "./read-model-schema.ts";

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

// Every name that reaches SQL passes through here, so `where` and `orderBy` can only name real
// columns.
export const columnFor: ColumnForFunction = ({ field, columns }) => {
  const column = columns.find((candidate) => candidate.field === field);
  if (column === undefined) {
    throw new ConfigurationError(
      `Unknown field "${field}"; the read model has: ${columns.map((c) => c.field).join(", ")}`,
    );
  }
  return column;
};

export type RangeOperator = "gt" | "gte" | "lt" | "lte";

// Values are as the caller gave them; each table encodes them for its engine. `eq` and `ne` take
// `null` for "no value", a range and `in` never do.
export type Condition =
  | {
      readonly operator: "eq" | "ne" | RangeOperator;
      readonly column: ColumnDefinition;
      readonly value: unknown;
    }
  | {
      readonly operator: "in";
      readonly column: ColumnDefinition;
      readonly values: readonly unknown[];
    };

const OPERATORS: ReadonlySet<string> = new Set(["gt", "gte", "lt", "lte", "ne", "in"]);

// A JSON column's value is matched whole, so an object there is a value, not operators.
const isOperators = (column: ColumnDefinition, value: unknown): value is object =>
  column.type !== "json" &&
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Date) &&
  !Array.isArray(value);

const operand = (column: ColumnDefinition, operator: string, value: unknown): unknown => {
  if (value === null) {
    throw new ConfigurationError(`Field "${column.field}": "${operator}" needs a value, got null`);
  }
  return value;
};

const conditionsOfField = (column: ColumnDefinition, value: unknown): Condition[] => {
  if (!isOperators(column, value)) return [{ operator: "eq", column, value: value ?? null }];
  const conditions = Object.entries(value).flatMap(([operator, given]): Condition[] => {
    if (!OPERATORS.has(operator)) {
      throw new ConfigurationError(
        `Field "${column.field}": unknown operator "${operator}"; use gt, gte, lt, lte, ne or in`,
      );
    }
    if (given === undefined) return [];
    if (operator === "ne") return [{ operator, column, value: given }];
    if (operator !== "in") {
      if (column.type === "boolean") {
        throw new ConfigurationError(
          `Field "${column.field}": a boolean has no order for "${operator}"; use ne or in`,
        );
      }
      return [
        { operator: operator as RangeOperator, column, value: operand(column, operator, given) },
      ];
    }
    if (!Array.isArray(given)) {
      throw new ConfigurationError(`Field "${column.field}": "in" needs an array`);
    }
    return [{ operator, column, values: given.map((item) => operand(column, operator, item)) }];
  });
  // Matching every row here would turn a missing operand into a `delete` of the whole table.
  if (conditions.length === 0) {
    throw new ConfigurationError(
      `Field "${column.field}": no operator has a value; leave the field out to match any row`,
    );
  }
  return conditions;
};

export interface ConditionsOfArgs {
  readonly where: Readonly<Record<string, unknown>> | undefined;
  readonly columns: readonly ColumnDefinition[];
}

export interface ConditionsOfFunction {
  (args: ConditionsOfArgs): readonly Condition[];
}

/**
 * The conditions of a `where`, all of which a row must meet. Throws `ConfigurationError` for a
 * field the view does not have, an operator `Where` does not offer, a `null` operand, or operators
 * none of which has a value.
 */
export const conditionsOf: ConditionsOfFunction = ({ where, columns }) =>
  Object.entries(where ?? {}).flatMap(([field, value]) =>
    conditionsOfField(columnFor({ field, columns }), value),
  );

export interface BuildWhereArgs {
  readonly where: Readonly<Record<string, unknown>> | undefined;
  readonly columns: readonly ColumnDefinition[];
  readonly dialect: SqlDialect;
  // How many parameters precede this fragment in the statement, for `$n` placeholders.
  readonly offset?: number;
}

export interface BuildWhereFunction {
  (args: BuildWhereArgs): SqlFragment;
}

const COMPARISONS: Readonly<Record<RangeOperator, string>> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

export const buildWhere: BuildWhereFunction = ({ where, columns, dialect, offset = 0 }) => {
  const conditions = conditionsOf({ where, columns });
  if (conditions.length === 0) return { sql: "", params: [] };
  const params: unknown[] = [];
  const bind = (condition: Condition, value: unknown): string => {
    params.push(dialect.encode(condition.column.type, value));
    return dialect.placeholder(offset + params.length);
  };
  // `ne` keeps the rows without a value, as `!==` does: SQL's `<>` would leave them out.
  const distinct = dialect.name === "postgresql" ? "IS DISTINCT FROM" : "IS NOT";
  const clauses = conditions.map((condition) => {
    const name = quoteIdentifier(condition.column.name);
    switch (condition.operator) {
      case "in":
        return condition.values.length === 0
          ? "1 = 0"
          : `${name} IN (${condition.values.map((value) => bind(condition, value)).join(", ")})`;
      case "eq":
        return condition.value === null
          ? `${name} IS NULL`
          : `${name} = ${bind(condition, condition.value)}`;
      case "ne":
        return condition.value === null
          ? `${name} IS NOT NULL`
          : `${name} ${distinct} ${bind(condition, condition.value)}`;
      default:
        return `${name} ${COMPARISONS[condition.operator]} ${bind(condition, condition.value)}`;
    }
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

// Rows without a value come first as SQLite and the in-memory tables put them, where PostgreSQL
// would put them last. Only a nullable column says so: the clause would keep PostgreSQL from
// reading a required column, the primary key included, in the order of its index.
export const buildOrderBy: BuildOrderByFunction = ({ orderBy, columns }) => {
  if (orderBy === undefined) return "";
  const column = columnFor({ field: orderBy.field, columns });
  const descending = orderBy.direction === "desc";
  const nulls = column.nullable ? (descending ? " NULLS LAST" : " NULLS FIRST") : "";
  return ` ORDER BY ${quoteIdentifier(column.name)} ${descending ? "DESC" : "ASC"}${nulls}`;
};

export interface BuildLimitArgs {
  readonly limit: number | undefined;
  readonly offset: number | undefined;
  readonly dialect: SqlDialect;
  // How many parameters precede this fragment in the statement.
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

export interface AssertPageArgs {
  readonly limit?: number;
  readonly offset?: number;
}

export interface AssertPageFunction {
  (args: AssertPageArgs): void;
}

/**
 * A `ConfigurationError` unless `limit` and `offset` are absent or non-negative integers, as
 * `buildLimit` requires.
 */
export const assertPage: AssertPageFunction = ({ limit, offset }) => {
  if (limit !== undefined) assertCount(limit, "limit");
  if (offset !== undefined) assertCount(offset, "offset");
};

export const buildLimit: BuildLimitFunction = ({ limit, offset, dialect, paramOffset }) => {
  if (limit === undefined && offset === undefined) return { sql: "", params: [] };
  const params: unknown[] = [];
  const parts: string[] = [];
  // SQLite needs a `LIMIT` before an `OFFSET`, so an offset alone gets `LIMIT -1` there.
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
