/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { fieldBuilder as f } from "../../modules/view.ts";
import { contractFields, tableContract } from "../testing/table.contract.ts";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";
import { columnsOf, createTableStatements, evolveTableStatements } from "./read-model-schema.ts";
import { createSqlReadClient, createSqlTable, decodeRow, type SqlExecutor } from "./sql-table.ts";

const sqliteExecutor = (db: DatabaseSync): SqlExecutor => ({
  run: async (sql, params) => {
    db.prepare(sql).run(...(params as SQLInputValue[]));
  },
  all: async (sql, params) =>
    db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[],
});

const recordingExecutor = (): SqlExecutor & { readonly statements: [string, unknown[]][] } => {
  const statements: [string, unknown[]][] = [];
  return {
    statements,
    run: async (sql, params) => {
      statements.push([sql, [...params]]);
    },
    all: async (sql, params) => {
      statements.push([sql, [...params]]);
      return [];
    },
  };
};

const openContractTable = async (db: DatabaseSync) => {
  const columns = columnsOf({
    readModel: "orderSummary",
    fields: contractFields,
    dialect: sqliteDialect,
  });
  for (const statement of createTableStatements({ table: "order_summary", columns }))
    db.exec(statement);
  return createSqlTable<{
    readonly orderId: string;
    readonly customerId: string;
    readonly status: string;
    readonly total: number;
    readonly paidAt?: Date;
  }>({
    readModel: "orderSummary",
    table: "order_summary",
    fields: contractFields,
    dialect: sqliteDialect,
    executor: sqliteExecutor(db),
  });
};

describe("createSqlTable on SQLite", () => {
  tableContract({ create: () => openContractTable(new DatabaseSync(":memory:")) });

  it("round-trips booleans and json and leaves NULL columns out", async () => {
    const db = new DatabaseSync(":memory:");
    const fields = {
      id: f.string().primaryKey(),
      active: f.boolean(),
      tags: f.json<readonly string[]>().optional(),
    };
    const columns = columnsOf({ readModel: "flags", fields, dialect: sqliteDialect });
    for (const statement of createTableStatements({ table: "flags", columns })) db.exec(statement);
    const table = createSqlTable<{ id: string; active: boolean; tags?: readonly string[] }>({
      readModel: "flags",
      table: "flags",
      fields,
      dialect: sqliteDialect,
      executor: sqliteExecutor(db),
    });
    await table.insert({ id: "a", active: true, tags: ["x", "y"] });
    await table.insert({ id: "b", active: false });
    expect(await table.findMany({ orderBy: { field: "id", direction: "asc" } })).toEqual([
      { id: "a", active: true, tags: ["x", "y"] },
      { id: "b", active: false },
    ]);
    expect(await table.findMany({ where: { active: false } })).toEqual([
      { id: "b", active: false },
    ]);
    expect(await table.count({ active: false })).toBe(1);
    await table.update({ id: "b" }, { tags: [] });
    expect(await table.findOne({ id: "b" })).toEqual({ id: "b", active: false, tags: [] });
    await table.update({ id: "b" }, {});
    expect(await table.count()).toBe(2);
  });

  it("evolves an existing table additively using the engine's column report", async () => {
    const db = new DatabaseSync(":memory:");
    const v1 = { id: f.string().primaryKey(), total: f.number() };
    const v2 = { ...v1, note: f.string().optional(), paid: f.boolean().index() };
    for (const statement of createTableStatements({
      table: "orders",
      columns: columnsOf({ readModel: "orders", fields: v1, dialect: sqliteDialect }),
    })) {
      db.exec(statement);
    }
    db.prepare('INSERT INTO "orders" ("id", "total") VALUES (?, ?)').run("o-1", 5);

    const existing = (
      db.prepare('PRAGMA table_info("orders")').all() as { name: string; type: string }[]
    ).map((column) => ({ name: column.name, sqlType: column.type }));
    const statements = evolveTableStatements({
      readModel: "orders",
      table: "orders",
      columns: columnsOf({ readModel: "orders", fields: v2, dialect: sqliteDialect }),
      existing,
    });
    expect(statements).toHaveLength(3);
    for (const statement of statements) db.exec(statement);

    const table = createSqlTable<{ id: string; total: number; note?: string; paid: boolean }>({
      readModel: "orders",
      table: "orders",
      fields: v2,
      dialect: sqliteDialect,
      executor: sqliteExecutor(db),
    });
    expect(await table.findOne({ id: "o-1" })).toEqual({ id: "o-1", total: 5 });
    await table.upsert({ id: "o-1", total: 5, paid: true });
    expect(await table.findOne({ id: "o-1" })).toEqual({ id: "o-1", total: 5, paid: true });
  });
});

describe("createSqlTable statements for PostgreSQL", () => {
  const fields = {
    orderId: f.string().primaryKey(),
    status: f.string(),
    paidAt: f.date().optional(),
  };
  const open = () => {
    const executor = recordingExecutor();
    const table = createSqlTable<{ orderId: string; status: string; paidAt?: Date }>({
      readModel: "orders",
      table: "bounda_orders",
      fields,
      dialect: postgresqlDialect,
      executor,
    });
    return { table, executor };
  };

  it("writes idempotently through ON CONFLICT with $n placeholders", async () => {
    const { table, executor } = open();
    const paidAt = new Date("2026-01-01T00:00:00.000Z");
    await table.upsert({ orderId: "o-1", status: "paid", paidAt });
    await table.insert({ orderId: "o-1", status: "placed" });
    await table.update({ orderId: "o-1" }, { status: "paid", paidAt });
    await table.delete({ status: "placed" });
    expect(executor.statements).toEqual([
      [
        'INSERT INTO "bounda_orders" ("order_id", "status", "paid_at") VALUES ($1, $2, $3) ON CONFLICT ("order_id") DO UPDATE SET "status" = excluded."status", "paid_at" = excluded."paid_at"',
        ["o-1", "paid", paidAt],
      ],
      [
        'INSERT INTO "bounda_orders" ("order_id", "status", "paid_at") VALUES ($1, $2, $3) ON CONFLICT ("order_id") DO NOTHING',
        ["o-1", "placed", null],
      ],
      [
        'UPDATE "bounda_orders" SET "status" = $1, "paid_at" = $2 WHERE "order_id" = $3',
        ["paid", paidAt, "o-1"],
      ],
      ['DELETE FROM "bounda_orders" WHERE "status" = $1', ["placed"]],
    ]);
  });

  it("reads with allow-listed columns, ordering and paging", async () => {
    const { table, executor } = open();
    await table.findOne({ orderId: "o-1" });
    await table.findMany({
      where: { status: "paid" },
      orderBy: { field: "paidAt", direction: "desc" },
      limit: 10,
      offset: 20,
    });
    await table.count();
    expect(executor.statements).toEqual([
      [
        'SELECT "order_id", "status", "paid_at" FROM "bounda_orders" WHERE "order_id" = $1 LIMIT $2',
        ["o-1", 1],
      ],
      [
        'SELECT "order_id", "status", "paid_at" FROM "bounda_orders" WHERE "status" = $1 ORDER BY "paid_at" DESC LIMIT $2 OFFSET $3',
        ["paid", 10, 20],
      ],
      ['SELECT COUNT(*) AS count FROM "bounda_orders"', []],
    ]);
  });

  it("does nothing on conflict when the primary key is the only column", async () => {
    const executor = recordingExecutor();
    const table = createSqlTable<{ id: string }>({
      readModel: "ids",
      table: "ids",
      fields: { id: f.string().primaryKey() },
      dialect: postgresqlDialect,
      executor,
    });
    await table.upsert({ id: "a" });
    expect(executor.statements[0]?.[0]).toBe(
      'INSERT INTO "ids" ("id") VALUES ($1) ON CONFLICT ("id") DO NOTHING',
    );
  });
});

describe("createSqlReadClient", () => {
  it("runs hand-written SQL and decodes rows like the table does", async () => {
    const db = new DatabaseSync(":memory:");
    const table = await openContractTable(db);
    await table.insert({
      orderId: "1",
      customerId: "c-1",
      status: "paid",
      total: 10,
      paidAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await table.insert({ orderId: "2", customerId: "c-1", status: "placed", total: 5 });
    const client = createSqlReadClient<{ orderId: string; paidAt?: Date }, DatabaseSync>({
      readModel: "orderSummary",
      fields: contractFields,
      dialect: sqliteDialect,
      executor: sqliteExecutor(db),
      raw: db,
    });
    expect(client.raw).toBe(db);
    expect(
      await client.get("SELECT order_id, paid_at FROM order_summary WHERE order_id = ?", ["1"]),
    ).toEqual({
      orderId: "1",
      paidAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(
      await client.get("SELECT order_id FROM order_summary WHERE order_id = ?", ["9"]),
    ).toBeNull();
    expect(
      await client.all(
        "SELECT customer_id, SUM(total) AS grand_total FROM order_summary GROUP BY customer_id",
      ),
    ).toEqual([{ customerId: "c-1", grandTotal: 15 }]);
  });

  it("decodes aliases it does not know by camelCasing them", () => {
    const columns = columnsOf({
      readModel: "x",
      fields: { id: f.string().primaryKey() },
      dialect: sqliteDialect,
    });
    expect(
      decodeRow({ row: { id: "a", row_count: 2, gone: null }, columns, dialect: sqliteDialect }),
    ).toEqual({
      id: "a",
      rowCount: 2,
      gone: null,
    });
  });
});
