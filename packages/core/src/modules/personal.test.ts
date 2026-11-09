import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_PERSONAL_CATEGORY } from "../adapter/storage/personal-key-store.ts";
import { person, personal, personalMarkOf } from "./personal.ts";

describe("personal and person", () => {
  it("validate as the schema they wrap and hand the value through", () => {
    const schema = z.object({
      customerId: person(z.string().min(1)),
      email: personal(z.email()),
      note: personal(z.string()).optional(),
    });
    expect(schema.parse({ customerId: "c-1", email: "ana@example.com" })).toEqual({
      customerId: "c-1",
      email: "ana@example.com",
    });
    expect(schema.safeParse({ customerId: "", email: "ana@example.com" }).success).toBe(false);
    expect(schema.safeParse({ customerId: "c-1", email: "ana" }).success).toBe(false);
  });

  it("mark the schema they return, found through any wrapper and never on the one they took", () => {
    const email = z.email();
    const marked = { mark: "personal", category: DEFAULT_PERSONAL_CATEGORY };
    expect(personalMarkOf(personal(email))).toEqual(marked);
    expect(personalMarkOf(personal(email).optional().nullable())).toEqual(marked);
    expect(personalMarkOf(person(z.string()))).toEqual({ mark: "person" });
    expect(personalMarkOf(person(z.string()).default("x").readonly())).toEqual({
      mark: "person",
    });
    expect(personalMarkOf(personal(email).transform((value) => value?.toLowerCase()))).toEqual(
      marked,
    );
    expect(personalMarkOf(z.string().pipe(z.email()))).toBeNull();
    expect(personalMarkOf(email)).toBeNull();
    expect(personalMarkOf(z.object({ email: personal(email) }))).toBeNull();
  });

  it("mark a personal field with the category it is given, the default one without", () => {
    expect(personalMarkOf(personal(z.email(), { category: "profile" }).optional())).toEqual({
      mark: "personal",
      category: "profile",
    });
    expect(personalMarkOf(personal(z.email(), {}))).toEqual({
      mark: "personal",
      category: DEFAULT_PERSONAL_CATEGORY,
    });
    expect(DEFAULT_PERSONAL_CATEGORY).toBe("default");
  });
});
