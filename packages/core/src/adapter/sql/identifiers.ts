import { ConfigurationError } from "../../contracts/errors.ts";

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export interface ToSnakeCaseFunction {
  (name: string): string;
}

/**
 * `orderSummary` → `order_summary`, `paidAt` → `paid_at`. Kebab-case dashes become underscores.
 */
export const toSnakeCase: ToSnakeCaseFunction = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-+/g, "_")
    .toLowerCase();

export interface FromSnakeCaseFunction {
  (name: string): string;
}

/**
 * `paid_at` → `paidAt`. The inverse of `toSnakeCase` for column names coming back from a query.
 */
export const fromSnakeCase: FromSnakeCaseFunction = (name) =>
  name.replace(/_+([a-z0-9])/g, (_, character: string) => character.toUpperCase());

export interface AssertIdentifierArgs {
  readonly name: string;
  readonly subject: string;
}

export interface AssertIdentifierFunction {
  (args: AssertIdentifierArgs): string;
}

/**
 * Accepts `^[a-z][a-z0-9_]*$` and nothing else, so a table or column name can never carry SQL.
 */
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

export interface TableNameForArgs {
  readonly prefix: string;
  readonly readModel: string;
}

export interface TableNameForFunction {
  (args: TableNameForArgs): string;
}

/**
 * The table of a read model: `<prefix><read_model>`, e.g. `bounda_order_summary`.
 */
export const tableNameFor: TableNameForFunction = ({ prefix, readModel }) =>
  assertIdentifier({ name: `${prefix}${toSnakeCase(readModel)}`, subject: "Table name" });
