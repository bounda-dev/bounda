import { describe, expect, it } from "vitest";
import { fieldBuilder as f } from "../../modules/view.ts";
import { isLeftOut, isRetainedKey, restrictedFieldsOf } from "./restricted-persons.ts";
import { storedFields } from "./sealed-fields.ts";

describe("restrictedFieldsOf", () => {
  const fields = {
    orderId: f.string().primaryKey(),
    customerId: f.string().person(),
    note: f.string().personal({ category: "profile" }),
    email: f.string().personal(),
    address: f.string().personal({ category: "invoices", clear: true }),
    alias: f.string().personal({ category: "profile" }),
    total: f.number(),
  };

  it("names the person field, the categories of the personal fields, each once, in order, and their key fields as stored", () => {
    expect(restrictedFieldsOf(storedFields({ readModel: "orders", fields }))).toEqual({
      person: "customerId",
      categories: ["default", "invoices", "profile"],
      keyFields: ["note__key", "email__key", "address__key", "alias__key"],
    });
  });

  it("names no key field the fields given lack", () => {
    expect(restrictedFieldsOf(fields)?.keyFields).toEqual([]);
  });

  it("is null for a read model without a person field, and names no category without personal fields", () => {
    expect(restrictedFieldsOf({ orderId: f.string().primaryKey() })).toBeNull();
    expect(
      restrictedFieldsOf({ customerId: f.string().primaryKey().person(), total: f.number() }),
    ).toEqual({ person: "customerId", categories: [], keyFields: [] });
  });
});

describe("isLeftOut", () => {
  const whole = { source: "legal-claims" as const, category: null };
  const profile = { source: "objection-pending" as const, category: "profile" };

  it("leaves a person out by a restriction of them as a whole or of a category the read model holds, on every view but all", () => {
    expect(isLeftOut({ restrictions: [whole], categories: [], view: "unrestricted" })).toBe(true);
    expect(isLeftOut({ restrictions: [profile], categories: ["profile"], view: "retained" })).toBe(
      true,
    );
    expect(
      isLeftOut({ restrictions: [profile], categories: ["invoices"], view: "unrestricted" }),
    ).toBe(false);
    expect(isLeftOut({ restrictions: [whole], categories: ["invoices"], view: "all" })).toBe(false);
    expect(isLeftOut({ restrictions: [], categories: ["invoices"], view: "unrestricted" })).toBe(
      false,
    );
  });
});

describe("isRetainedKey", () => {
  it("tells a key field marked as kept by a forgetting", () => {
    expect(isRetainedKey("retained:f-1")).toBe(true);
    expect(isRetainedKey("f-1")).toBe(false);
    expect(isRetainedKey(null)).toBe(false);
    expect(isRetainedKey(undefined)).toBe(false);
  });
});
