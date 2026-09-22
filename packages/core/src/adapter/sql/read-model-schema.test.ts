import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";
import {
  columnsOf,
  createTableStatements,
  dropShadowTableStatements,
  evolveTableStatements,
  rebuildTablesFor,
  shadowTableStatements,
  swapTableStatements,
} from "./read-model-schema.ts";

const fields = {
  orderId: f.string().primaryKey(),
  customerId: f.string().index(),
  email: f.string().unique(),
  total: f.number(),
  paid: f.boolean(),
  paidAt: f.date().optional(),
  lines: f.json<readonly string[]>().optional().index(),
};

describe("columnsOf", () => {
  it("maps fields to snake_case columns with the dialect's types", () => {
    const columns = columnsOf({ readModel: "orderSummary", fields, dialect: postgresqlDialect });
    expect(columns.map((column) => [column.field, column.name, column.sqlType])).toEqual([
      ["orderId", "order_id", "text"],
      ["customerId", "customer_id", "text"],
      ["email", "email", "text"],
      ["total", "total", "double precision"],
      ["paid", "paid", "boolean"],
      ["paidAt", "paid_at", "timestamp with time zone"],
      ["lines", "lines", "jsonb"],
    ]);
    expect(columns[0]).toMatchObject({ primaryKey: true, nullable: false, type: "string" });
    expect(columns[1]).toMatchObject({ indexed: true, unique: false });
    expect(columns[2]).toMatchObject({ unique: true });
    expect(columns[5]).toMatchObject({ nullable: true });
  });

  it("requires exactly one primary key", () => {
    expect(() =>
      columnsOf({ readModel: "x", fields: { a: f.string() }, dialect: sqliteDialect }),
    ).toThrow(new ConfigurationError('Read model "x" declares no primary key field'));
    expect(() =>
      columnsOf({
        readModel: "x",
        fields: { a: f.string().primaryKey(), b: f.string().primaryKey() },
        dialect: sqliteDialect,
      }),
    ).toThrow('Read model "x" declares more than one primary key field: a, b');
  });

  it("rejects field names that do not become identifiers", () => {
    expect(() =>
      columnsOf({
        readModel: "x",
        fields: { id: f.string().primaryKey(), "bad name": f.string() },
        dialect: sqliteDialect,
      }),
    ).toThrow('Read model "x": column for field "bad name" is not a valid SQL identifier');
  });
});

describe("createTableStatements", () => {
  it("creates the table and one index per indexed, non-unique column", () => {
    const columns = columnsOf({ readModel: "orderSummary", fields, dialect: sqliteDialect });
    expect(createTableStatements({ table: "bounda_order_summary", columns })).toEqual([
      'CREATE TABLE IF NOT EXISTS "bounda_order_summary" ("order_id" TEXT PRIMARY KEY, "customer_id" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE, "total" REAL NOT NULL, "paid" INTEGER NOT NULL, "paid_at" TEXT, "lines" TEXT)',
      'CREATE INDEX IF NOT EXISTS "bounda_order_summary_customer_id_idx" ON "bounda_order_summary" ("customer_id")',
      'CREATE INDEX IF NOT EXISTS "bounda_order_summary_lines_idx" ON "bounda_order_summary" ("lines")',
    ]);
  });

  it("uses the PostgreSQL types for that dialect", () => {
    const columns = columnsOf({
      readModel: "orders",
      fields: { id: f.string().primaryKey(), paidAt: f.date() },
      dialect: postgresqlDialect,
    });
    expect(createTableStatements({ table: "orders", columns })).toEqual([
      'CREATE TABLE IF NOT EXISTS "orders" ("id" text PRIMARY KEY, "paid_at" timestamp with time zone NOT NULL)',
    ]);
  });
});

describe("evolveTableStatements", () => {
  const columns = columnsOf({ readModel: "orderSummary", fields, dialect: sqliteDialect });
  const existing = columns.map((column) => ({ name: column.name, sqlType: column.sqlType }));

  it("returns nothing when the table already matches, whatever the type's case", () => {
    expect(
      evolveTableStatements({
        readModel: "orderSummary",
        table: "t",
        columns,
        existing: existing.map((column) => ({ ...column, sqlType: column.sqlType.toLowerCase() })),
      }),
    ).toEqual([]);
  });

  it("adds missing columns as nullable, with their indexes", () => {
    expect(
      evolveTableStatements({
        readModel: "orderSummary",
        table: "t",
        columns,
        existing: existing.filter((column) => column.name !== "lines" && column.name !== "paid"),
      }),
    ).toEqual([
      'ALTER TABLE "t" ADD COLUMN "paid" INTEGER',
      'ALTER TABLE "t" ADD COLUMN "lines" TEXT',
      'CREATE INDEX IF NOT EXISTS "t_lines_idx" ON "t" ("lines")',
    ]);
  });

  it("refuses removed columns and type changes, naming the read model", () => {
    expect(() =>
      evolveTableStatements({
        readModel: "orderSummary",
        table: "t",
        columns,
        existing: [...existing, { name: "legacy", sqlType: "TEXT" }],
      }),
    ).toThrow(
      'Read model "orderSummary": table "t" has columns that are no longer in fields (legacy). Removing a field needs a rebuild: run `bounda rebuild orderSummary`',
    );
    expect(() =>
      evolveTableStatements({
        readModel: "orderSummary",
        table: "t",
        columns,
        existing: existing.map((column) =>
          column.name === "total" ? { ...column, sqlType: "TEXT" } : column,
        ),
      }),
    ).toThrow(
      'Read model "orderSummary": column "total" is TEXT in table "t" but fields now declare REAL. Changing a field\'s type needs a rebuild: run `bounda rebuild orderSummary`',
    );
  });
});

describe("rebuild statements", () => {
  const columns = columnsOf({ readModel: "orderSummary", fields, dialect: sqliteDialect });

  it("names the shadow and the retired table after the live one", () => {
    expect(rebuildTablesFor("bounda_order_summary")).toEqual({
      shadow: "bounda_order_summary__rebuild",
      retired: "bounda_order_summary__retired",
    });
  });

  it("refuses a live table name that is not an identifier", () => {
    expect(() => rebuildTablesFor("Bounda Orders")).toThrow(
      'Table name "Bounda Orders__rebuild" is not a valid SQL identifier',
    );
  });

  it("clears leftovers and creates the shadow with its indexes", () => {
    expect(shadowTableStatements({ table: "t", columns })).toEqual([
      'DROP TABLE IF EXISTS "t__rebuild"',
      'DROP TABLE IF EXISTS "t__retired"',
      'CREATE TABLE IF NOT EXISTS "t__rebuild" ("order_id" TEXT PRIMARY KEY, "customer_id" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE, "total" REAL NOT NULL, "paid" INTEGER NOT NULL, "paid_at" TEXT, "lines" TEXT)',
      'CREATE INDEX IF NOT EXISTS "t__rebuild_customer_id_idx" ON "t__rebuild" ("customer_id")',
      'CREATE INDEX IF NOT EXISTS "t__rebuild_lines_idx" ON "t__rebuild" ("lines")',
    ]);
  });

  it("swaps the shadow into place and gives the indexes their canonical names", () => {
    expect(swapTableStatements({ table: "t", columns, live: true })).toEqual([
      'ALTER TABLE "t" RENAME TO "t__retired"',
      'ALTER TABLE "t__rebuild" RENAME TO "t"',
      'DROP TABLE IF EXISTS "t__retired"',
      'DROP INDEX IF EXISTS "t__rebuild_customer_id_idx"',
      'DROP INDEX IF EXISTS "t__rebuild_lines_idx"',
      'CREATE INDEX IF NOT EXISTS "t_customer_id_idx" ON "t" ("customer_id")',
      'CREATE INDEX IF NOT EXISTS "t_lines_idx" ON "t" ("lines")',
    ]);
  });

  it("has nothing to retire when the read model never had a table", () => {
    expect(swapTableStatements({ table: "t", columns, live: false })[0]).toBe(
      'ALTER TABLE "t__rebuild" RENAME TO "t"',
    );
    expect(swapTableStatements({ table: "t", columns, live: false })).toHaveLength(6);
  });

  it("drops only the shadow on abort", () => {
    expect(dropShadowTableStatements("t")).toEqual(['DROP TABLE IF EXISTS "t__rebuild"']);
  });
});
