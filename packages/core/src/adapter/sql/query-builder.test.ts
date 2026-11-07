import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";
import { assertPage, buildLimit, buildOrderBy, buildWhere, columnFor } from "./query-builder.ts";
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

  it("writes each operator, with `ne` keeping rows without a value", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(
      buildWhere({
        where: {
          orderId: { gt: "a", lte: "z", ne: "m" },
          customerId: { in: ["c-1", "c-2"], ne: null },
          paidAt: { gte: at, lt: undefined },
          paid: { in: [] },
        },
        columns: pg,
        dialect: postgresqlDialect,
        offset: 1,
      }),
    ).toEqual({
      sql: ' WHERE "order_id" > $2 AND "order_id" <= $3 AND "order_id" IS DISTINCT FROM $4 AND "customer_id" IN ($5, $6) AND "customer_id" IS NOT NULL AND "paid_at" >= $7 AND 1 = 0',
      params: ["a", "z", "m", "c-1", "c-2", at],
    });
    expect(
      buildWhere({
        where: { paid: { ne: true }, paidAt: { lt: at } },
        columns: lite,
        dialect: sqliteDialect,
      }),
    ).toEqual({ sql: ' WHERE "paid" IS NOT ? AND "paid_at" < ?', params: [1, at.toISOString()] });
  });

  it("refuses an unknown operator, a null operand and an `in` without an array", () => {
    const where = (value: unknown) => () =>
      buildWhere({ where: { customerId: value }, columns: pg, dialect: postgresqlDialect });
    expect(where({ like: "c%" })).toThrow(
      new ConfigurationError(
        'Field "customerId": unknown operator "like"; use gt, gte, lt, lte, ne or in',
      ),
    );
    expect(where({ gt: null })).toThrow(
      new ConfigurationError('Field "customerId": "gt" needs a value, got null'),
    );
    expect(where({ in: [null] })).toThrow(
      new ConfigurationError('Field "customerId": "in" needs a value, got null'),
    );
    expect(where({ in: "c-1" })).toThrow(
      new ConfigurationError('Field "customerId": "in" needs an array'),
    );
    expect(where({ gt: undefined })).toThrow(
      new ConfigurationError(
        'Field "customerId": no operator has a value; leave the field out to match any row',
      ),
    );
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

describe("assertPage", () => {
  it("takes no count or non-negative integers, zero included, and names a wrong one", () => {
    expect(() => assertPage({})).not.toThrow();
    expect(() => assertPage({ limit: 0, offset: 0 })).not.toThrow();
    expect(() => assertPage({ limit: -1 })).toThrow("limit must be a non-negative integer, got -1");
    expect(() => assertPage({ offset: 1.5 })).toThrow(
      "offset must be a non-negative integer, got 1.5",
    );
  });
});
