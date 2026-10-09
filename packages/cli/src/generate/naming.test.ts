import { describe, expect, it } from "vitest";
import {
  compareNames,
  isKebabCase,
  joinKeys,
  keyOf,
  processDeadlineOf,
  processHandlerEventOf,
  typeNameOf,
  uniqueAliases,
} from "./naming.ts";

describe("isKebabCase", () => {
  it.each(["order", "order-placed", "on-timeout", "v2-report", "a1"])("accepts %s", (name) => {
    expect(isKebabCase(name)).toBe(true);
  });

  it.each(["Order", "order_placed", "-order", "order-", "order--placed", "", "ordér", "1st"])(
    "rejects %j",
    (name) => {
      expect(isKebabCase(name)).toBe(false);
    },
  );
});

describe("keyOf / typeNameOf / joinKeys", () => {
  it("derives registry keys and type names from file names", () => {
    expect(keyOf("order-placed")).toBe("orderPlaced");
    expect(keyOf("index")).toBe("index");
    expect(typeNameOf("orderPlaced")).toBe("OrderPlaced");
    expect(joinKeys("orderSummary", "on", "orderPlaced")).toBe("orderSummaryOnOrderPlaced");
    expect(joinKeys("auditLog", "memory")).toBe("auditLogMemory");
    expect(joinKeys("order")).toBe("order");
  });
});

describe("processDeadlineOf", () => {
  it("takes the field after at-", () => {
    expect(processDeadlineOf("at-next-reminder")).toBe("nextReminder");
    expect(processDeadlineOf("at-timeout")).toBe("timeout");
    expect(processDeadlineOf("on-timeout")).toBeNull();
    expect(processDeadlineOf("at-")).toBeNull();
  });
});

describe("processHandlerEventOf", () => {
  it("takes the event after on-", () => {
    expect(processHandlerEventOf("on-order-paid")).toBe("orderPaid");
    expect(processHandlerEventOf("on-timeout")).toBe("timeout");
    expect(processHandlerEventOf("order-paid")).toBeNull();
    expect(processHandlerEventOf("on-")).toBeNull();
  });
});

describe("compareNames", () => {
  it("orders by code unit, whatever the machine's locale", () => {
    expect(compareNames("same", "same")).toBe(0);
    expect(["zebra", "tz", "aaron", "Zed", "b"].sort(compareNames)).toEqual([
      "Zed",
      "aaron",
      "b",
      "tz",
      "zebra",
    ]);
  });
});

describe("uniqueAliases", () => {
  it("keeps aliases that are unique and prefixes the ones that collide with their owner", () => {
    expect(
      uniqueAliases({
        entries: [
          { alias: "created", owner: "order" },
          { alias: "created", owner: "customer" },
          { alias: "orderPlaced", owner: "order" },
        ],
      }),
    ).toEqual(["orderCreated", "customerCreated", "orderPlaced"]);
    expect(uniqueAliases({ entries: [] })).toEqual([]);
  });

  it("numbers past an alias already taken, however many repeat", () => {
    expect(
      uniqueAliases({
        entries: [
          { alias: "checkout", owner: "order" },
          { alias: "checkout", owner: "order" },
          { alias: "checkout", owner: "order" },
          { alias: "orderCheckout2", owner: "order" },
        ],
      }),
    ).toEqual(["orderCheckout", "orderCheckout3", "orderCheckout4", "orderCheckout2"]);
  });

  it("prefixes a reserved word and numbers an alias that still repeats", () => {
    expect(
      uniqueAliases({
        entries: [
          { alias: "delete", owner: "order" },
          { alias: "default", owner: "order" },
          { alias: "registry", owner: "order" },
          { alias: "checkout", owner: "order" },
          { alias: "checkout", owner: "order" },
          { alias: "created", owner: "order" },
          { alias: "created", owner: "customer" },
          { alias: "orderCreated", owner: "order" },
        ],
      }),
    ).toEqual([
      "orderDelete",
      "orderDefault",
      "orderRegistry",
      "orderCheckout",
      "orderCheckout2",
      "orderCreated",
      "customerCreated",
      "orderCreated2",
    ]);
  });
});
