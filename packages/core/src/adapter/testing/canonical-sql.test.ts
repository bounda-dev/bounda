import { describe, expect, it } from "vitest";
import { canonicalSql } from "./canonical-sql.ts";

describe("canonicalSql", () => {
  it("reads a column added to a table as one the table was created with", () => {
    expect(
      canonicalSql(`CREATE TABLE "t" (
    "a" TEXT NOT NULL, "b" TEXT DEFAULT 'x',
    PRIMARY KEY ("a")
  )`),
    ).toBe(
      canonicalSql(`CREATE TABLE "t" ("a" TEXT NOT NULL,
  "b" TEXT DEFAULT 'x', PRIMARY KEY ( "a" ) )`),
    );
  });

  it("keeps one space between words and none beside a parenthesis or a comma", () => {
    expect(canonicalSql(' CREATE  TABLE\n"t" ( "a"\tTEXT , "b" INTEGER ) WITHOUT  ROWID ')).toBe(
      'CREATE TABLE "t"("a" TEXT,"b" INTEGER) WITHOUT ROWID',
    );
  });

  it("keeps what quotes hold as it is, spaces and doubled quotes too", () => {
    expect(canonicalSql(`SELECT 'it''s  ( , )'  , "a  ""b"" "`)).toBe(
      `SELECT 'it''s  ( , )',"a  ""b"" "`,
    );
  });

  it("tells apart what differs in more than spacing", () => {
    expect(canonicalSql('"a" TEXT NOT NULL')).not.toBe(canonicalSql('"a" TEXT'));
    expect(canonicalSql("DEFAULT ' x'")).not.toBe(canonicalSql("DEFAULT 'x'"));
    expect(canonicalSql('"a" TEXT,"b" TEXT')).not.toBe(canonicalSql('"b" TEXT,"a" TEXT'));
  });
});
