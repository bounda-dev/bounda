import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "../../contracts/errors.ts";
import { validState } from "./handlers.ts";

const refused = (run: () => unknown): ValidationError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("expected a ValidationError");
};

describe("validState", () => {
  it("takes the state as it is when the process has no schema", () => {
    const state = { anything: true };

    expect(validState({ name: "order.orderPayment", stateSchema: null }, state)).toBe(state);
  });

  it("returns the state its schema parses", () => {
    const stateSchema = z.object({ attempts: z.number().default(0) });

    expect(validState({ name: "order.orderPayment", stateSchema }, {})).toEqual({ attempts: 0 });
  });

  it("refuses a state its schema refuses, with every issue by path and message", () => {
    const stateSchema = z.object({
      attempts: z.number(),
      items: z.array(z.object({ sku: z.string() })),
    });

    const error = refused(() =>
      validState(
        { name: "order.orderPayment", stateSchema },
        { attempts: "two", items: [{ sku: 1 }] },
      ),
    );

    expect(error.message).toBe("Process order.orderPayment returned a state its schema refuses");
    expect(error.issues).toEqual([
      { path: ["attempts"], message: expect.any(String) },
      { path: ["items", 0, "sku"], message: expect.any(String) },
    ]);
  });

  it("leaves symbol segments out of an issue's path", () => {
    const stateSchema = z.object({}).superRefine((_, context) => {
      context.addIssue({ code: "custom", message: "refused", path: [Symbol("meta"), "items", 0] });
    });

    const error = refused(() => validState({ name: "order.orderPayment", stateSchema }, {}));

    expect(error.issues).toEqual([{ path: ["items", 0], message: "refused" }]);
  });
});
