import { describe, expect, it } from "vitest";
import { capitalize, toCamelCase } from "./naming.ts";

describe("capitalize", () => {
  it("upper-cases the first character only", () => {
    expect(capitalize("orderPlaced")).toBe("OrderPlaced");
    expect(capitalize("x")).toBe("X");
    expect(capitalize("")).toBe("");
  });
});

describe("toCamelCase", () => {
  it("converts kebab-case file names to registry keys", () => {
    expect(toCamelCase("order-placed")).toBe("orderPlaced");
    expect(toCamelCase("send-receipt-on-order-paid")).toBe("sendReceiptOnOrderPaid");
    expect(toCamelCase("v2-report")).toBe("v2Report");
    expect(toCamelCase("order")).toBe("order");
  });
});
