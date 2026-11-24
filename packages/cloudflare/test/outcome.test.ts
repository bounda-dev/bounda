import { DomainError, NotFoundError, type Rejection, ValidationError } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { refused, settle, unwrap } from "../src/outcome.ts";

const issues = [{ path: ["total"], message: "Expected number" }];

describe("settle", () => {
  it("answers the value of work that succeeds", async () => {
    expect(await settle(async () => 42)).toStrictEqual({ ok: true, value: 42 });
  });

  it("answers a refusal with only the fields its error carries", async () => {
    expect(
      await settle(() => Promise.reject(new NotFoundError('Unknown query "nope"'))),
    ).toStrictEqual({
      ok: false,
      refusal: { name: "NotFoundError", code: "NOT_FOUND", message: 'Unknown query "nope"' },
    });
    expect(
      await settle(() => Promise.reject(new ValidationError("Invalid payload", issues))),
    ).toStrictEqual({
      ok: false,
      refusal: {
        name: "ValidationError",
        code: "VALIDATION_FAILED",
        message: "Invalid payload",
        issues,
      },
    });
    expect(
      await settle(() =>
        Promise.reject(
          new DomainError({
            code: "AlreadyPlaced",
            message: "Order already placed",
          } as Rejection<"AlreadyPlaced">),
        ),
      ),
    ).toStrictEqual({
      ok: false,
      refusal: {
        name: "DomainError",
        code: "DOMAIN_ERROR",
        message: "Order already placed",
        rejected: "AlreadyPlaced",
      },
    });
  });

  it("throws any other error as it is", async () => {
    const outage = new Error("storage is down");
    await expect(settle(() => Promise.reject(outage))).rejects.toBe(outage);
  });
});

describe("unwrap", () => {
  it("answers the value of a success", async () => {
    expect(await unwrap(Promise.resolve({ ok: true, value: 42 }))).toBe(42);
  });

  it("throws a refusal again with only the fields it carries", async () => {
    const thrown = async (refusal: object): Promise<Error> =>
      unwrap(Promise.resolve({ ok: false, refusal })).then(
        () => {
          throw new Error("expected a rejection");
        },
        (error: Error) => error,
      );
    const notFound = await thrown({ name: "NotFoundError", code: "NOT_FOUND", message: "Gone" });
    expect(notFound).toBeInstanceOf(Error);
    expect({ ...notFound, message: notFound.message }).toStrictEqual({
      name: "NotFoundError",
      code: "NOT_FOUND",
      message: "Gone",
    });
    const rejected = await thrown({
      name: "DomainError",
      code: "DOMAIN_ERROR",
      message: "Order already placed",
      issues,
      rejected: "AlreadyPlaced",
    });
    expect({ ...rejected, message: rejected.message }).toStrictEqual({
      name: "DomainError",
      code: "DOMAIN_ERROR",
      message: "Order already placed",
      issues,
      rejected: "AlreadyPlaced",
    });
  });
});

describe("refused", () => {
  const since = "2026-01-01T00:00:00.000Z";

  it("throws a fence's refusal again as the error it was, and nothing else as one", () => {
    expect(
      refused({
        name: "TenantFrozenError",
        code: "TENANT_FROZEN",
        message: "frozen",
        fenced: { tenant: "acme", since },
      }),
    ).toMatchObject({ name: "TenantFrozenError", tenant: "acme", frozenAt: since });
    expect(
      refused({
        name: "TenantForgottenError",
        code: "TENANT_FORGOTTEN",
        message: "forgotten",
        fenced: { tenant: "acme", since },
      }),
    ).toMatchObject({ name: "TenantForgottenError", tenant: "acme", forgottenAt: since });
    for (const code of ["TENANT_FROZEN", "TENANT_FORGOTTEN"]) {
      const plain = refused({ name: "Error", code, message: "no fence" });
      expect(plain.constructor).toBe(Error);
      expect(plain).toMatchObject({ code, message: "no fence" });
    }
    const other = refused({
      name: "NotFoundError",
      code: "NOT_FOUND",
      message: "Gone",
      fenced: { tenant: "acme", since },
    });
    expect(other.constructor).toBe(Error);
    expect(other).toMatchObject({ name: "NotFoundError", code: "NOT_FOUND" });
  });
});
