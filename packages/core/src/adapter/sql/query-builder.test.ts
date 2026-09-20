import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";
import { buildLimit, buildOrderBy, buildWhere, columnFor } from "./query-builder.ts";
import { columnsOf } from "./read-model-schema.ts";

const fields = {
  orderId: f.string().primaryKey(),
  customerId: f.string(),
  paid: f.boolean(),
  paidAt: f.date().optional(),
};
const pg = columnsOf({ readModel: "orders", fields, dialect: postgresqlDialect });
const lite = columnsOf({ readModel: "orders", fields, dialect: sqliteDialect });

describe("buildWhere", () => {
  it("is empty without conditions", () => {
    expect(buildWhere({ where: undefined, columns: pg, dialect: postgresqlDialect })).toEqual({
      sql: "",
      params: [],
    });
    expect(buildWhere({ where: {}, columns: pg, dialect: postgresqlDialect })).toEqual({
      sql: "",
      params: [],
    });
  });

  it("numbers placeholders after the given offset and encodes values", () => {
    expect(
      buildWhere({
        where: { customerId: "c-1", paid: true, paidAt: undefined },
        columns: pg,
        dialect: postgresqlDialect,
        offset: 2,
      }),
    ).toEqual({
      sql: ' WHERE "customer_id" = $3 AND "paid" = $4 AND "paid_at" IS NULL',
      params: ["c-1", true],
    });
    expect(
      buildWhere({ where: { paid: false, paidAt: null }, columns: lite, dialect: sqliteDialect }),
    ).toEqual({ sql: ' WHERE "paid" = ? AND "paid_at" IS NULL', params: [0] });
  });

  it("rejects fields the read model does not declare", () => {
    expect(() =>
      buildWhere({ where: { nope: 1 }, columns: pg, dialect: postgresqlDialect }),
    ).toThrow(
      new ConfigurationError(
        'Unknown field "nope"; the read model has: orderId, customerId, paid, paidAt',
      ),
    );
    expect(() => columnFor({ field: "x", columns: pg })).toThrow(ConfigurationError);
  });
});

describe("buildOrderBy", () => {
  it("orders by an allow-listed column", () => {
    expect(buildOrderBy({ orderBy: undefined, columns: pg })).toBe("");
    expect(buildOrderBy({ orderBy: { field: "paidAt", direction: "desc" }, columns: pg })).toBe(
      ' ORDER BY "paid_at" DESC',
    );
    expect(buildOrderBy({ orderBy: { field: "orderId", direction: "asc" }, columns: pg })).toBe(
      ' ORDER BY "order_id" ASC',
    );
    expect(() =>
      buildOrderBy({ orderBy: { field: "total", direction: "asc" }, columns: pg }),
    ).toThrow(ConfigurationError);
  });
});

describe("buildLimit", () => {
  it("binds limit and offset as parameters after the preceding ones", () => {
    expect(
      buildLimit({
        limit: undefined,
        offset: undefined,
        dialect: postgresqlDialect,
        paramOffset: 1,
      }),
    ).toEqual({ sql: "", params: [] });
    expect(
      buildLimit({ limit: 5, offset: 10, dialect: postgresqlDialect, paramOffset: 1 }),
    ).toEqual({ sql: " LIMIT $2 OFFSET $3", params: [5, 10] });
    expect(
      buildLimit({ limit: 5, offset: undefined, dialect: sqliteDialect, paramOffset: 0 }),
    ).toEqual({ sql: " LIMIT ?", params: [5] });
  });

  it("gives SQLite an unbounded LIMIT when only an offset is set", () => {
    expect(
      buildLimit({ limit: undefined, offset: 3, dialect: sqliteDialect, paramOffset: 0 }),
    ).toEqual({ sql: " LIMIT ? OFFSET ?", params: [-1, 3] });
    expect(
      buildLimit({ limit: undefined, offset: 3, dialect: postgresqlDialect, paramOffset: 0 }),
    ).toEqual({ sql: " OFFSET $1", params: [3] });
  });

  it("rejects negative or fractional counts", () => {
    expect(() =>
      buildLimit({ limit: -1, offset: undefined, dialect: sqliteDialect, paramOffset: 0 }),
    ).toThrow("limit must be a non-negative integer, got -1");
    expect(() =>
      buildLimit({ limit: 1, offset: 1.5, dialect: sqliteDialect, paramOffset: 0 }),
    ).toThrow("offset must be a non-negative integer, got 1.5");
  });
});
