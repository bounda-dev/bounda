import type { FieldType } from "../../modules/view.ts";

/**
 * What differs between SQL engines when Bounda stores a read model: parameter placeholders,
 * column types, and how field values travel to and from the driver.
 */
export interface SqlDialect {
  readonly name: "sqlite" | "postgresql";
  /**
   * The placeholder of the n-th parameter, counting from 1.
   */
  placeholder(index: number): string;
  /**
   * The column type for a field, as `CREATE TABLE` declares it and as the engine reports it back.
   */
  columnType(type: FieldType): string;
  /**
   * Converts a field value into what the driver binds. `undefined` becomes `null`.
   */
  encode(type: FieldType, value: unknown): unknown;
  /**
   * Converts a value the driver returned into the field's TypeScript type. `null` becomes
   * `undefined`, which the table then leaves out of the row.
   */
  decode(type: FieldType, value: unknown): unknown;
}

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;

const toNumber = (value: unknown): number => (typeof value === "number" ? value : Number(value));

const decodeCommon = (type: FieldType, value: unknown): unknown => {
  switch (type) {
    case "string":
      return String(value);
    case "number":
      return toNumber(value);
    case "date":
      return toDate(value);
    case "json":
      return parseJson(value);
    case "boolean":
      return typeof value === "boolean" ? value : Number(value) !== 0;
  }
};

const SQLITE_TYPES: Readonly<Record<FieldType, string>> = {
  string: "TEXT",
  number: "REAL",
  boolean: "INTEGER",
  date: "TEXT",
  json: "TEXT",
};

const POSTGRESQL_TYPES: Readonly<Record<FieldType, string>> = {
  string: "text",
  number: "double precision",
  boolean: "boolean",
  date: "timestamp with time zone",
  json: "jsonb",
};

/**
 * SQLite: `?` placeholders, booleans as 0/1, dates as ISO-8601 text, JSON as text.
 */
export const sqliteDialect: SqlDialect = {
  name: "sqlite",
  placeholder: () => "?",
  columnType: (type) => SQLITE_TYPES[type],
  encode: (type, value) => {
    if (value === undefined || value === null) return null;
    switch (type) {
      case "boolean":
        return value ? 1 : 0;
      case "date":
        return toDate(value).toISOString();
      case "json":
        return JSON.stringify(value);
      default:
        return value;
    }
  },
  decode: (type, value) =>
    value === null || value === undefined ? undefined : decodeCommon(type, value),
};

/**
 * PostgreSQL: `$n` placeholders, native booleans and timestamps, JSON as `jsonb`.
 */
export const postgresqlDialect: SqlDialect = {
  name: "postgresql",
  placeholder: (index) => `$${index}`,
  columnType: (type) => POSTGRESQL_TYPES[type],
  encode: (type, value) => {
    if (value === undefined || value === null) return null;
    switch (type) {
      case "date":
        return toDate(value);
      case "json":
        return JSON.stringify(value);
      default:
        return value;
    }
  },
  decode: (type, value) =>
    value === null || value === undefined ? undefined : decodeCommon(type, value),
};
