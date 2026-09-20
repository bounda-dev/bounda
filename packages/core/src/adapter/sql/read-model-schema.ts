import { ConfigurationError } from "../../contracts/errors.ts";
import type { FieldsRecord, FieldType } from "../../modules/view.ts";
import type { SqlDialect } from "./dialect.ts";
import { assertIdentifier, quoteIdentifier, toSnakeCase } from "./identifiers.ts";

/**
 * One read-model field as a column: the TypeScript name, the column name and the DDL facts.
 */
export interface ColumnDefinition {
  readonly field: string;
  readonly name: string;
  readonly type: FieldType;
  readonly sqlType: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly indexed: boolean;
}

export interface ColumnsOfArgs {
  readonly readModel: string;
  readonly fields: FieldsRecord;
  readonly dialect: SqlDialect;
}

export interface ColumnsOfFunction {
  (args: ColumnsOfArgs): readonly ColumnDefinition[];
}

/**
 * Maps a view's `fields` to columns in declaration order. Exactly one field must be the primary
 * key; every column name must be a valid identifier after snake_casing.
 */
export const columnsOf: ColumnsOfFunction = ({ readModel, fields, dialect }) => {
  const columns = Object.entries(fields).map(
    ([field, definition]): ColumnDefinition => ({
      field,
      name: assertIdentifier({
        name: toSnakeCase(field),
        subject: `Read model "${readModel}": column for field`,
      }),
      type: definition.type,
      sqlType: dialect.columnType(definition.type),
      nullable: definition.isOptional && !definition.isPrimaryKey,
      primaryKey: definition.isPrimaryKey,
      unique: definition.isUnique,
      indexed: definition.isIndexed,
    }),
  );
  const primaryKeys = columns.filter((column) => column.primaryKey);
  if (primaryKeys.length === 0) {
    throw new ConfigurationError(`Read model "${readModel}" declares no primary key field`);
  }
  if (primaryKeys.length > 1) {
    throw new ConfigurationError(
      `Read model "${readModel}" declares more than one primary key field: ${primaryKeys
        .map((column) => column.field)
        .join(", ")}`,
    );
  }
  return columns;
};

const indexName = (table: string, column: ColumnDefinition): string =>
  quoteIdentifier(`${table}_${column.name}_idx`);

const columnClause = (column: ColumnDefinition): string =>
  [
    quoteIdentifier(column.name),
    column.sqlType,
    column.primaryKey ? "PRIMARY KEY" : column.nullable ? "" : "NOT NULL",
    column.unique && !column.primaryKey ? "UNIQUE" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

export interface CreateTableStatementsArgs {
  readonly table: string;
  readonly columns: readonly ColumnDefinition[];
}

export interface CreateTableStatementsFunction {
  (args: CreateTableStatementsArgs): readonly string[];
}

/**
 * `CREATE TABLE IF NOT EXISTS` plus one `CREATE INDEX IF NOT EXISTS` per indexed column. Valid in
 * SQLite and PostgreSQL.
 */
export const createTableStatements: CreateTableStatementsFunction = ({ table, columns }) => [
  `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (${columns.map(columnClause).join(", ")})`,
  ...columns
    .filter((column) => column.indexed && !column.primaryKey && !column.unique)
    .map(
      (column) =>
        `CREATE INDEX IF NOT EXISTS ${indexName(table, column)} ON ${quoteIdentifier(table)} (${quoteIdentifier(column.name)})`,
    ),
];

/**
 * A column as the engine reports it: its name and declared type.
 */
export interface ExistingColumn {
  readonly name: string;
  readonly sqlType: string;
}

export interface EvolveTableStatementsArgs {
  readonly readModel: string;
  readonly table: string;
  readonly columns: readonly ColumnDefinition[];
  readonly existing: readonly ExistingColumn[];
}

export interface EvolveTableStatementsFunction {
  (args: EvolveTableStatementsArgs): readonly string[];
}

const sameType = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The statements that bring an existing table up to the current `fields`. Evolution is additive:
 * new fields become nullable columns (existing rows have no value for them) with their indexes;
 * a field that disappeared or changed type is an error naming the read model, because rebuilding
 * a table silently would drop data. Rename the read model to start it from scratch.
 */
export const evolveTableStatements: EvolveTableStatementsFunction = ({
  readModel,
  table,
  columns,
  existing,
}) => {
  const byName = new Map(existing.map((column) => [column.name, column]));
  const removed = existing.filter((column) => !columns.some((c) => c.name === column.name));
  if (removed.length > 0) {
    throw new ConfigurationError(
      `Read model "${readModel}": table "${table}" has columns that are no longer in fields (${removed
        .map((column) => column.name)
        .join(", ")}). Removing fields is not supported yet; rename the read model to rebuild it`,
    );
  }
  for (const column of columns) {
    const current = byName.get(column.name);
    if (current !== undefined && !sameType(current.sqlType, column.sqlType)) {
      throw new ConfigurationError(
        `Read model "${readModel}": column "${column.name}" is ${current.sqlType} in table "${table}" but fields now declare ${column.sqlType}. Changing a field's type is not supported yet; rename the read model to rebuild it`,
      );
    }
  }
  const added = columns.filter((column) => !byName.has(column.name));
  return added.flatMap((column) => [
    `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column.name)} ${column.sqlType}`,
    ...(column.indexed && !column.unique
      ? [
          `CREATE INDEX IF NOT EXISTS ${indexName(table, column)} ON ${quoteIdentifier(table)} (${quoteIdentifier(column.name)})`,
        ]
      : []),
  ]);
};
