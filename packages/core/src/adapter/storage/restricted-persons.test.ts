import { describe, expect, it } from "vitest";
import { fieldBuilder as f } from "../../modules/view.ts";
import { isLeftOut, RETAINED_SOURCE, restrictedFieldsOf } from "./restricted-persons.ts";

describe("restrictedFieldsOf", () => {
  it("names the person field and the categories of the personal fields, each once, in order", () => {
    expect(
      restrictedFieldsOf({
        orderId: f.string().primaryKey(),
        customerId: f.string().person(),
        note: f.string().personal({ category: "profile" }),
        email: f.string().personal(),
        address: f.string().personal({ category: "invoices" }),
        alias: f.string().personal({ category: "profile" }),
        total: f.number(),
      }),
    ).toEqual({ person: "customerId", categories: ["default", "invoices", "profile"] });
  });

  it("is null for a read model without a person field, and names no category without personal fields", () => {
    expect(restrictedFieldsOf({ orderId: f.string().primaryKey() })).toBeNull();
    expect(
      restrictedFieldsOf({ customerId: f.string().primaryKey().person(), total: f.number() }),
    ).toEqual({ person: "customerId", categories: [] });
  });
});

describe("isLeftOut", () => {
  const whole = { source: "legal-claims" as const, category: null };
  const profile = { source: "objection-pending" as const, category: "profile" };
  const kept = { source: RETAINED_SOURCE, category: "invoices" };

  it("leaves a person out by a restriction of them as a whole or of a category the read model holds, and what a forgetting kept only from the unrestricted view", () => {
    expect(isLeftOut({ restrictions: [whole], categories: [], view: "unrestricted" })).toBe(true);
    expect(isLeftOut({ restrictions: [profile], categories: ["profile"], view: "retained" })).toBe(
      true,
    );
    expect(
      isLeftOut({ restrictions: [profile], categories: ["invoices"], view: "unrestricted" }),
    ).toBe(false);
    expect(
      isLeftOut({ restrictions: [kept], categories: ["invoices"], view: "unrestricted" }),
    ).toBe(true);
    expect(isLeftOut({ restrictions: [kept], categories: ["invoices"], view: "retained" })).toBe(
      false,
    );
    expect(isLeftOut({ restrictions: [whole, kept], categories: ["invoices"], view: "all" })).toBe(
      false,
    );
    expect(isLeftOut({ restrictions: [], categories: ["invoices"], view: "unrestricted" })).toBe(
      false,
    );
  });
});
