import { ConfigurationError } from "../../contracts/errors.ts";

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export interface ToSnakeCaseFunction {
  (name: string): string;
}

export const toSnakeCase: ToSnakeCaseFunction = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-+/g, "_")
    .toLowerCase();

export interface FromSnakeCaseFunction {
  (name: string): string;
}

export const fromSnakeCase: FromSnakeCaseFunction = (name) =>
  name.replace(/_+([a-z0-9])/g, (_, character: string) => character.toUpperCase());

export interface AssertIdentifierArgs {
  readonly name: string;
  readonly subject: string;
}

export interface AssertIdentifierFunction {
  (args: AssertIdentifierArgs): string;
}

// So a table or column name can never carry SQL.
export const assertIdentifier: AssertIdentifierFunction = ({ name, subject }) => {
  if (!IDENTIFIER.test(name)) {
    throw new ConfigurationError(
      `${subject} "${name}" is not a valid SQL identifier; use lower-case letters, digits and underscores, starting with a letter`,
    );
  }
  return name;
};

export interface QuoteIdentifierFunction {
  (name: string): string;
}

/**
 * Validates and double-quotes an identifier. Works in SQLite and PostgreSQL alike.
 */
export const quoteIdentifier: QuoteIdentifierFunction = (name) =>
  `"${assertIdentifier({ name, subject: "Identifier" })}"`;

/**
 * Between the prefix and a read model's name, so no read model can take the name of a storage
 * table: a read model called `events` would otherwise open, and rebuild, the event store.
 */
const READ_MODEL_TABLE_INFIX = "rm_";

export interface TableNameForArgs {
  readonly prefix: string;
  readonly readModel: string;
}

export interface TableNameForFunction {
  (args: TableNameForArgs): string;
}

/**
 * The table of a read model: `<prefix>rm_<read_model>`, e.g. `bounda_rm_order_summary`.
 */
export const tableNameFor: TableNameForFunction = ({ prefix, readModel }) =>
  assertIdentifier({
    name: `${prefix}${READ_MODEL_TABLE_INFIX}${toSnakeCase(readModel)}`,
    subject: "Table name",
  });

export interface StorageTableNameForArgs {
  readonly prefix: string;
  readonly table: string;
}

export interface StorageTableNameForFunction {
  (args: StorageTableNameForArgs): string;
}

/**
 * A storage table: `<prefix><table>`, e.g. `bounda_scheduled_commands`.
 */
export const storageTableNameFor: StorageTableNameForFunction = ({ prefix, table }) =>
  assertIdentifier({ name: `${prefix}${toSnakeCase(table)}`, subject: "Table name" });
