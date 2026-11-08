import { describe, expect, it } from "vitest";
import {
  ConcurrencyError,
  DeadLetterSettledError,
  NotFoundError,
  ValidationError,
} from "../../contracts/errors.ts";
import { errorFields } from "./error-fields.ts";
import { ThrownValue } from "./retry.ts";
import { runtimeText } from "./runtime-text.ts";

describe("errorFields", () => {
  it("keeps an error's class and code, and its text only with include", () => {
    const quoting = new ValidationError("ana@example.com is taken", []);
    expect(errorFields({ error: quoting })).toEqual({
      errorName: "ValidationError",
      errorCode: "VALIDATION_FAILED",
    });
    expect(errorFields({ error: quoting, errorText: "omit" })).toEqual({
      errorName: "ValidationError",
      errorCode: "VALIDATION_FAILED",
    });
    expect(errorFields({ error: quoting, errorText: "include" })).toEqual({
      errorName: "ValidationError",
      errorCode: "VALIDATION_FAILED",
      errorMessage: "ana@example.com is taken",
      errorStack: expect.stringContaining("ana@example.com is taken"),
    });
  });

  it("names what was thrown that is no error by its type, wrapped or not", () => {
    for (const error of ["ana@example.com", new ThrownValue("ana@example.com")]) {
      expect(errorFields({ error })).toEqual({ errorName: "string" });
      expect(errorFields({ error, errorText: "include" })).toEqual({
        errorName: "string",
        errorMessage: "ana@example.com",
      });
    }
  });

  it("keeps the message of an error whose text Bounda writes from names and ids alone, never its stack", () => {
    const conflict = new ConcurrencyError({
      streamId: "order:o-1",
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect(errorFields({ error: conflict })).toEqual({
      errorName: "ConcurrencyError",
      errorCode: "CONCURRENCY_CONFLICT",
      errorMessage: "Stream order:o-1 is at version 2, expected 1",
    });
    expect(errorFields({ error: new DeadLetterSettledError({ id: "d-1" }) })).toMatchObject({
      errorMessage: 'Dead letter "d-1" is no longer failed: another retry or discard settled it',
    });
    expect(
      errorFields({ error: runtimeText(new NotFoundError('Dead letter "d-1" not found')) }),
    ).toEqual({
      errorName: "NotFoundError",
      errorCode: "NOT_FOUND",
      errorMessage: 'Dead letter "d-1" not found',
    });
  });

  it("keeps no message of the same errors made by anyone else, or of a subclass", () => {
    class Quoting extends ConcurrencyError {
      constructor() {
        super({ streamId: "order:o-1", expectedVersion: 1, actualVersion: 2 });
        this.message = "ana@example.com";
      }
    }
    expect(errorFields({ error: new NotFoundError("no customer ana@example.com") })).toEqual({
      errorName: "NotFoundError",
      errorCode: "NOT_FOUND",
    });
    expect(errorFields({ error: new Quoting() })).toEqual({
      errorName: "Quoting",
      errorCode: "CONCURRENCY_CONFLICT",
    });
  });
});
