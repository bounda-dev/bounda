import { describe, expect, it } from "vitest";
import type { FieldType } from "../../modules/view.ts";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";

const FIELD_TYPES: readonly FieldType[] = ["string", "number", "boolean", "date", "json"];
const when = new Date("2026-01-02T03:04:05.000Z");

describe("sqliteDialect", () => {
  it("uses ? placeholders and text-friendly column types", () => {
    expect(sqliteDialect.placeholder(1)).toBe("?");
    expect(sqliteDialect.placeholder(7)).toBe("?");
    expect(FIELD_TYPES.map((type) => sqliteDialect.columnType(type))).toEqual([
      "TEXT",
      "REAL",
      "INTEGER",
      "TEXT",
      "TEXT",
    ]);
  });

  it("encodes booleans as 0/1, dates as ISO text and json as text", () => {
    expect(sqliteDialect.encode("boolean", true)).toBe(1);
    expect(sqliteDialect.encode("boolean", false)).toBe(0);
    expect(sqliteDialect.encode("date", when)).toBe("2026-01-02T03:04:05.000Z");
    expect(sqliteDialect.encode("date", "2026-01-02T03:04:05.000Z")).toBe(
      "2026-01-02T03:04:05.000Z",
    );
    expect(sqliteDialect.encode("json", { a: [1] })).toBe('{"a":[1]}');
    expect(sqliteDialect.encode("string", "x")).toBe("x");
    expect(sqliteDialect.encode("number", 2.5)).toBe(2.5);
    expect(sqliteDialect.encode("string", undefined)).toBeNull();
    expect(sqliteDialect.encode("json", null)).toBeNull();
  });

  it("decodes back to field types and turns NULL into undefined", () => {
    expect(sqliteDialect.decode("boolean", 1)).toBe(true);
    expect(sqliteDialect.decode("boolean", 0)).toBe(false);
    expect(sqliteDialect.decode("date", "2026-01-02T03:04:05.000Z")).toEqual(when);
    expect(sqliteDialect.decode("json", '{"a":[1]}')).toEqual({ a: [1] });
    expect(sqliteDialect.decode("number", 3)).toBe(3);
    expect(sqliteDialect.decode("number", "3")).toBe(3);
    expect(sqliteDialect.decode("string", "s")).toBe("s");
    expect(sqliteDialect.decode("string", null)).toBeUndefined();
    expect(sqliteDialect.decode("date", undefined)).toBeUndefined();
  });
});

describe("postgresqlDialect", () => {
  it("uses $n placeholders and native column types", () => {
    expect([1, 2, 10].map(postgresqlDialect.placeholder)).toEqual(["$1", "$2", "$10"]);
    expect(FIELD_TYPES.map((type) => postgresqlDialect.columnType(type))).toEqual([
      "text",
      "double precision",
      "boolean",
      "timestamp with time zone",
      "jsonb",
    ]);
  });

  it("keeps booleans and dates native and serialises json", () => {
    expect(postgresqlDialect.encode("boolean", true)).toBe(true);
    expect(postgresqlDialect.encode("date", when)).toBe(when);
    expect(postgresqlDialect.encode("date", "2026-01-02T03:04:05.000Z")).toEqual(when);
    expect(postgresqlDialect.encode("json", [1, 2])).toBe("[1,2]");
    expect(postgresqlDialect.encode("number", undefined)).toBeNull();
  });

  it("decodes driver values, including json already parsed and numerics as strings", () => {
    expect(postgresqlDialect.decode("boolean", false)).toBe(false);
    expect(postgresqlDialect.decode("date", when)).toBe(when);
    expect(postgresqlDialect.decode("json", { a: 1 })).toEqual({ a: 1 });
    expect(postgresqlDialect.decode("json", '{"a":1}')).toEqual({ a: 1 });
    expect(postgresqlDialect.decode("number", "12.5")).toBe(12.5);
    expect(postgresqlDialect.decode("string", null)).toBeUndefined();
  });
});
