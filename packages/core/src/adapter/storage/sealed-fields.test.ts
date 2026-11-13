import { describe, expect, it } from "vitest";
import { fieldBuilder as f } from "../../modules/view.ts";
import {
  isHiddenField,
  isSealedField,
  storedFields,
  storedPersonalFields,
} from "./sealed-fields.ts";

describe("storedFields", () => {
  it("stores a sealed field as a string, moves its uniqueness or index to its blind index, and puts a key field after every personal one", () => {
    const stored = storedFields({
      readModel: "customers",
      fields: {
        customerId: f.string().primaryKey().person(),
        email: f.string().personal().unique(),
        born: f.date().optional().personal().index(),
        note: f.number().personal(),
        phone: f.string().personal({ clear: true }).index(),
        plan: f.string().index(),
      },
    });
    expect(Object.keys(stored)).toEqual([
      "customerId",
      "email",
      "born",
      "note",
      "phone",
      "plan",
      "email__key",
      "email__index",
      "born__key",
      "born__index",
      "note__key",
      "phone__key",
    ]);
    expect(stored.email).toMatchObject({
      type: "string",
      isUnique: false,
      isIndexed: false,
      mark: "personal",
    });
    expect(stored.born).toMatchObject({ type: "string", isOptional: true, isIndexed: false });
    expect(stored.note).toMatchObject({ type: "string", isOptional: false });
    expect(stored.phone).toMatchObject({ type: "string", isIndexed: true, clear: true });
    expect(stored.email__index).toMatchObject({
      isUnique: true,
      isIndexed: false,
      isOptional: true,
    });
    expect(stored.born__index).toMatchObject({ isUnique: false, isIndexed: true });
    expect(stored.note__key).toMatchObject({ type: "string", isOptional: true, mark: null });
  });

  it("refuses a sealed primary key, and a field a hidden field is named like", () => {
    expect(() =>
      storedFields({
        readModel: "customers",
        fields: { email: f.string().primaryKey().personal() },
      }),
    ).toThrow(
      'Read model "customers": primary key field "email" is marked .personal(), and a sealed value is never a key; key the rows by another field, or keep this one in the clear with .personal({ clear: true })',
    );
    expect(() =>
      storedFields({
        readModel: "customers",
        fields: { id: f.string().primaryKey(), email__key: f.string() },
      }),
    ).toThrow(
      'Read model "customers": field "email__key" ends with "__key" or "__index", which the runtime keeps beside personal fields; rename it',
    );
    expect(() =>
      storedFields({
        readModel: "customers",
        fields: { id: f.string().primaryKey(), email__index: f.string() },
      }),
    ).toThrow('field "email__index" ends with');
    expect(
      Object.keys(
        storedFields({
          readModel: "customers",
          fields: { email: f.string().primaryKey().person().optional() },
        }),
      ),
    ).toEqual(["email"]);
  });
});

describe("storedPersonalFields", () => {
  it("names each personal field with its category, whether it is sealed, and its hidden fields", () => {
    expect(
      storedPersonalFields({
        id: f.string().primaryKey(),
        email: f
          .string()
          .personal({ category: "profile" as never })
          .index(),
        phone: f.string().personal({ clear: true }).unique(),
      }).map(({ field, category, sealed, keyField, indexField }) => ({
        field,
        category,
        sealed,
        keyField,
        indexField,
      })),
    ).toEqual([
      {
        field: "email",
        category: "profile",
        sealed: true,
        keyField: "email__key",
        indexField: "email__index",
      },
      {
        field: "phone",
        category: "default",
        sealed: false,
        keyField: "phone__key",
        indexField: null,
      },
    ]);
  });
});

describe("isSealedField and isHiddenField", () => {
  it("tell a sealed field and a hidden one", () => {
    expect(isSealedField(f.string().personal())).toBe(true);
    expect(isSealedField(f.string().personal({ clear: true }))).toBe(false);
    expect(isSealedField(f.string())).toBe(false);
    expect(isHiddenField("email__key")).toBe(true);
    expect(isHiddenField("email_address__index")).toBe(true);
    expect(isHiddenField("email")).toBe(false);
    expect(isHiddenField("key")).toBe(false);
  });
});
