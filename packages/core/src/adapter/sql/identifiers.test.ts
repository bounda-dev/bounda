import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import {
  assertIdentifier,
  fromSnakeCase,
  quoteIdentifier,
  tableNameFor,
  toSnakeCase,
} from "./identifiers.ts";

describe("toSnakeCase / fromSnakeCase", () => {
  it.each([
    ["orderSummary", "order_summary"],
    ["paidAt", "paid_at"],
    ["customerV2Id", "customer_v2_id"],
    ["order-summary", "order_summary"],
    ["total", "total"],
  ])("%s → %s", (name, snake) => {
    expect(toSnakeCase(name)).toBe(snake);
  });

  it("folds runs of dashes and underscores", () => {
    expect(toSnakeCase("order--summary")).toBe("order_summary");
    expect(fromSnakeCase("paid__at")).toBe("paidAt");
    expect(fromSnakeCase("line_2_total")).toBe("line2Total");
  });

  it("round-trips camelCase names", () => {
    for (const name of ["orderId", "paidAt", "a1B2", "plain"]) {
      expect(fromSnakeCase(toSnakeCase(name))).toBe(name);
    }
    expect(fromSnakeCase("grand_total")).toBe("grandTotal");
  });
});

describe("assertIdentifier / quoteIdentifier", () => {
  it("accepts lower-case identifiers and quotes them", () => {
    expect(assertIdentifier({ name: "order_summary", subject: "Table" })).toBe("order_summary");
    expect(quoteIdentifier("paid_at")).toBe('"paid_at"');
  });

  it.each(['"; DROP TABLE x; --', "Order", "1st", "with space", "", "ñ"])("rejects %j", (name) => {
    expect(() => assertIdentifier({ name, subject: "Column" })).toThrow(ConfigurationError);
    expect(() => quoteIdentifier(name)).toThrow(/not a valid SQL identifier/);
  });

  it("names the subject in the error", () => {
    expect(() => assertIdentifier({ name: "Bad", subject: "Table name" })).toThrow(
      'Table name "Bad" is not a valid SQL identifier',
    );
  });
});

describe("tableNameFor", () => {
  it("prefixes the snake_cased read model name", () => {
    expect(tableNameFor({ prefix: "bounda_", readModel: "orderSummary" })).toBe(
      "bounda_order_summary",
    );
    expect(tableNameFor({ prefix: "", readModel: "orders" })).toBe("orders");
  });

  it("rejects prefixes that do not form an identifier", () => {
    expect(() => tableNameFor({ prefix: "1-", readModel: "orders" })).toThrow(ConfigurationError);
  });
});
