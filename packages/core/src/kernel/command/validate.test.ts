import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "../../contracts/errors.ts";
import { validatePayload } from "./validate.ts";

describe("validatePayload", () => {
  it("passes the payload through without a schema, defaulting to an empty object", () => {
    const payload = { total: 1 };
    expect(validatePayload({ schema: null, payload, subject: "x" })).toBe(payload);
    expect(validatePayload({ schema: null, payload: undefined, subject: "x" })).toEqual({});
    expect(validatePayload({ schema: null, payload: null, subject: "x" })).toEqual({});
  });

  it("returns the parsed value so defaults apply", () => {
    const schema = z.object({ total: z.number(), currency: z.string().default("EUR") });
    expect(validatePayload({ schema, payload: { total: 2 }, subject: "x" })).toEqual({
      total: 2,
      currency: "EUR",
    });
  });

  it("reports every issue with its path", () => {
    const schema = z.object({ lines: z.array(z.object({ qty: z.int() })), note: z.string() });
    let error: unknown;
    try {
      validatePayload({ schema, payload: { lines: [{ qty: 1.5 }] }, subject: "command Place" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe("Invalid payload for command Place");
    expect((error as ValidationError).issues).toEqual([
      { path: ["lines", 0, "qty"], message: expect.stringContaining("int") },
      { path: ["note"], message: expect.any(String) },
    ]);
  });
});
