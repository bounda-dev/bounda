import { ConcurrencyError, DomainError, type Rejection, ValidationError } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { failure } from "./failure.ts";

const rejection = { code: "AlreadyPlaced", message: "Order o-1 was already placed" } as Rejection;

describe("failure", () => {
  it("answers a payload that does not validate with a 400 and its issues", () => {
    const issues = [{ path: ["email"], message: "Invalid email" }];
    const answer = failure(new ValidationError("Invalid command RegisterUser", issues));
    expect(answer.data).toEqual({ error: "Invalid command RegisterUser", issues });
    expect(answer.init).toEqual({ status: 400 });
  });

  it("answers a command's rejection with a 409 and its code", () => {
    const answer = failure(new DomainError(rejection));
    expect(answer.data).toEqual({
      error: "Order o-1 was already placed",
      issues: [],
      rejected: "AlreadyPlaced",
    });
    expect(answer.init).toEqual({ status: 409 });
  });

  it("rethrows anything else, for the route's ErrorBoundary", () => {
    const conflict = new ConcurrencyError({
      streamId: "order:o-1",
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect(() => failure(conflict)).toThrow(conflict);
    const bug = new TypeError("boom");
    expect(() => failure(bug)).toThrow(bug);
  });
});
