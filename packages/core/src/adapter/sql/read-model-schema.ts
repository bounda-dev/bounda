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
 * a table silently would drop data. `bounda rebuild` does it on purpose.
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
        .join(", ")}). Removing a field needs a rebuild: run \`bounda rebuild ${readModel}\``,
    );
  }
  for (const column of columns) {
    const current = byName.get(column.name);
    if (current !== undefined && !sameType(current.sqlType, column.sqlType)) {
      throw new ConfigurationError(
        `Read model "${readModel}": column "${column.name}" is ${current.sqlType} in table "${table}" but fields now declare ${column.sqlType}. Changing a field's type needs a rebuild: run \`bounda rebuild ${readModel}\``,
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

/**
 * The tables a rebuild of `table` works with: the shadow the projections fill and the name the
 * live table takes for the instant between the swap and its drop.
 */
export interface RebuildTables {
  readonly shadow: string;
  readonly retired: string;
}

export interface RebuildTablesForFunction {
  (table: string): RebuildTables;
}

/**
 * `<table>__rebuild` and `<table>__retired`. Read-model names are camelCase, so their snake_case
 * tables never contain a double underscore and neither name can collide with another read model.
 */
export const rebuildTablesFor: RebuildTablesForFunction = (table) => ({
  shadow: assertIdentifier({ name: `${table}__rebuild`, subject: "Table name" }),
  retired: assertIdentifier({ name: `${table}__retired`, subject: "Table name" }),
});

export interface ShadowTableStatementsArgs {
  readonly table: string;
  readonly columns: readonly ColumnDefinition[];
}

export interface ShadowTableStatementsFunction {
  (args: ShadowTableStatementsArgs): readonly string[];
}

/**
 * Drops whatever an interrupted rebuild left behind and creates the shadow table with its indexes.
 */
export const shadowTableStatements: ShadowTableStatementsFunction = ({ table, columns }) => {
  const { shadow, retired } = rebuildTablesFor(table);
  return [
    `DROP TABLE IF EXISTS ${quoteIdentifier(shadow)}`,
    `DROP TABLE IF EXISTS ${quoteIdentifier(retired)}`,
    ...createTableStatements({ table: shadow, columns }),
  ];
};

export interface SwapTableStatementsArgs {
  readonly table: string;
  readonly columns: readonly ColumnDefinition[];
  /**
   * Whether the live table exists. A read model rebuilt before its first boot has none to retire.
   */
  readonly live: boolean;
}

export interface SwapTableStatementsFunction {
  (args: SwapTableStatementsArgs): readonly string[];
}

/**
 * Makes the shadow table the live one: retires the live table, renames the shadow into its place,
 * drops the retired one, and gives the indexes their canonical names. Index names are global in
 * PostgreSQL and SQLite cannot rename one, so the shadow's indexes are dropped and recreated
 * under the live table's names once the retired table, which held those names, is gone. Meant to
 * run inside one transaction.
 */
export const swapTableStatements: SwapTableStatementsFunction = ({ table, columns, live }) => {
  const { shadow, retired } = rebuildTablesFor(table);
  const indexed = columns.filter(
    (column) => column.indexed && !column.primaryKey && !column.unique,
  );
  return [
    ...(live
      ? [`ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(retired)}`]
      : []),
    `ALTER TABLE ${quoteIdentifier(shadow)} RENAME TO ${quoteIdentifier(table)}`,
    `DROP TABLE IF EXISTS ${quoteIdentifier(retired)}`,
    ...indexed.map((column) => `DROP INDEX IF EXISTS ${indexName(shadow, column)}`),
    ...indexed.map(
      (column) =>
        `CREATE INDEX IF NOT EXISTS ${indexName(table, column)} ON ${quoteIdentifier(table)} (${quoteIdentifier(column.name)})`,
    ),
  ];
};

export interface DropTableStatementsFunction {
  (table: string): readonly string[];
}

/**
 * What `abort` runs: the shadow table goes, the live one is not touched.
 */
export const dropShadowTableStatements: DropTableStatementsFunction = (table) => [
  `DROP TABLE IF EXISTS ${quoteIdentifier(rebuildTablesFor(table).shadow)}`,
];
