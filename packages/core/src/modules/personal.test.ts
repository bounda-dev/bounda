import { describe, expect, it } from "vitest";
import { z } from "zod";
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
    expect(personalMarkOf(personal(email))).toBe("personal");
    expect(personalMarkOf(personal(email).optional().nullable())).toBe("personal");
    expect(personalMarkOf(person(z.string()))).toBe("person");
    expect(personalMarkOf(person(z.string()).default("x").readonly())).toBe("person");
    expect(personalMarkOf(personal(email).transform((value) => value?.toLowerCase()))).toBe(
      "personal",
    );
    expect(personalMarkOf(z.string().pipe(z.email()))).toBeNull();
    expect(personalMarkOf(email)).toBeNull();
    expect(personalMarkOf(z.object({ email: personal(email) }))).toBeNull();
  });
});
