import type { FieldType } from "../../modules/view.ts";

export interface SqlDialect {
  readonly name: "sqlite" | "postgresql";
  // `index` counts from 1.
  placeholder(index: number): string;
  // As `CREATE TABLE` declares it and as the engine reports it back: evolving a table compares the
  // two.
  columnType(type: FieldType): string;
  // `undefined` binds as `null`.
  encode(type: FieldType, value: unknown): unknown;
  // `null` decodes to `undefined`, which the table then leaves out of the row.
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
 * A JSON value as Postgres.js should bind it. The driver types a parameter from the value before
 * it asks the server: `true`, a `Date`, or an array that starts with one would be sent as `bool`
 * or `timestamptz` into a `jsonb` column. An object is left untyped, so the server types it `jsonb`
 * and the driver serialises it with `JSON.stringify`, which calls `toJSON`.
 */
const jsonParameter = (value: unknown): { toJSON(): unknown } => ({
  // `JSON.stringify` calls one `toJSON` per value: this one, so the value's own, a date's
  // included, is called here.
  toJSON: () => {
    const own: unknown =
      typeof value === "object" && value !== null ? Reflect.get(value, "toJSON") : undefined;
    return typeof own === "function" ? own.call(value, "") : value;
  },
});

/**
 * PostgreSQL: `$n` placeholders, native booleans and timestamps, JSON as `jsonb`. The driver
 * parses `jsonb` as it reads it, so JSON comes back as it is.
 */
export const postgresqlDialect: SqlDialect = {
  name: "postgresql",
  placeholder: (index) => `$${index}`,
  columnType: (type) => POSTGRESQL_TYPES[type],
  encode: (type, value) => {
    if (value === undefined || value === null) return null;
    if (type === "date") return toDate(value);
    return type === "json" ? jsonParameter(value) : value;
  },
  decode: (type, value) => {
    if (value === null || value === undefined) return undefined;
    return type === "json" ? value : decodeCommon(type, value);
  },
};
