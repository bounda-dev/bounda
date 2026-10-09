import { describe, expect, it } from "vitest";
import {
  isKebabCase,
  joinKeys,
  keyOf,
  policyTriggerOf,
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

describe("policyTriggerOf", () => {
  it("takes the longest event the name ends with after -on-", () => {
    const events = ["orderPaid", "customerRegistered", "paymentFailed", "addOnRemoved", "removed"];
    const trigger = (fileName: string) => policyTriggerOf({ fileName, events });
    expect(trigger("send-receipt-on-order-paid")).toBe("orderPaid");
    expect(trigger("notify-on-customer-registered")).toBe("customerRegistered");
    expect(trigger("put-on-hold-on-payment-failed")).toBe("paymentFailed");
    expect(trigger("notify-on-add-on-removed")).toBe("addOnRemoved");
    expect(trigger("cleanup")).toBeNull();
    expect(trigger("on-order-paid")).toBeNull();
    expect(trigger("send-on-order-shipped")).toBeNull();
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

  it("prefixes a reserved word and numbers an alias that still repeats", () => {
    expect(
      uniqueAliases({
        entries: [
          { alias: "delete", owner: "order" },
          { alias: "default", owner: "order" },
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
      "orderCheckout",
      "orderCheckout2",
      "orderCreated",
      "customerCreated",
      "orderCreated2",
    ]);
  });
});
