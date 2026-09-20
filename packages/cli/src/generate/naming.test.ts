import { describe, expect, it } from "vitest";
import {
  collaboratorPartsOf,
  isKebabCase,
  joinKeys,
  keyOf,
  policyTriggerOf,
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
  it("takes the event after the last -on-", () => {
    expect(policyTriggerOf("send-receipt-on-order-paid")).toBe("orderPaid");
    expect(policyTriggerOf("notify-on-customer-registered")).toBe("customerRegistered");
    expect(policyTriggerOf("cleanup")).toBeNull();
    expect(policyTriggerOf("on-order-paid")).toBeNull();
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

describe("collaboratorPartsOf", () => {
  it("splits <collaborator>.<implementation>", () => {
    expect(collaboratorPartsOf("audit-log.memory")).toEqual({
      name: "auditLog",
      implementation: "memory",
    });
    expect(collaboratorPartsOf("inventory.fake")).toEqual({
      name: "inventory",
      implementation: "fake",
    });
    expect(collaboratorPartsOf("inventory")).toBeNull();
    expect(collaboratorPartsOf("inventory.fake.v2")).toBeNull();
    expect(collaboratorPartsOf("Inventory.fake")).toBeNull();
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
});
