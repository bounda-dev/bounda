import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { NotFoundError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import type { OnPersonalDataAccessArgs } from "../../modules/audit.ts";
import { checked, createAccessLog, recorded } from "./access.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

describe("createAccessLog", () => {
  it("hands the hook the record, the environment, the tenant and the logger, and waits for it", async () => {
    const received: OnPersonalDataAccessArgs[] = [];
    const record = createAccessLog({
      hook: async (args) => {
        await Promise.resolve();
        received.push(args);
      },
      env: { KEY: "value" },
      tenant: DEFAULT_TENANT,
      logger: silentLogger,
      clock: createFixedClock(new Date("2026-03-01T10:00:00.000Z")),
    });
    await record({
      operation: "deadLetters.get",
      detail: { letter: "dl-1" },
      actor: undefined,
      persons: ["ana", "bo", "ana"],
      outcome: "failed",
      error: new NotFoundError("ana@example.com is not here"),
      unattributed: true,
    });
    await record({
      operation: "query",
      detail: { query: "getCustomer", readModel: "customers" },
      actor: "agent-7",
      persons: [],
      outcome: "ok",
      error: new Error("not named in an ok record"),
      restricted: { basis: "legal-claims", persons: ["bo", "bo"] },
    });
    await record({
      operation: "subscriberFailures.list",
      detail: { failures: 0 },
      actor: undefined,
      persons: [],
      outcome: "refused",
      error: "ana@example.com",
    });
    expect(received).toStrictEqual([
      {
        access: {
          operation: "deadLetters.get",
          actor: null,
          persons: ["ana", "bo"],
          personCount: 2,
          at: "2026-03-01T10:00:00.000Z",
          outcome: "failed",
          errorName: "NotFoundError",
          errorCode: "NOT_FOUND",
          restricted: null,
          detail: { letter: "dl-1" },
        },
        env: { KEY: "value" },
        tenant: DEFAULT_TENANT,
        logger: silentLogger,
      },
      {
        access: {
          operation: "query",
          actor: "agent-7",
          persons: [],
          personCount: 0,
          at: "2026-03-01T10:00:00.000Z",
          outcome: "ok",
          errorName: null,
          errorCode: null,
          restricted: { basis: "legal-claims", persons: ["bo"], personCount: 1 },
          unattributed: false,
          detail: { query: "getCustomer", readModel: "customers" },
        },
        env: { KEY: "value" },
        tenant: DEFAULT_TENANT,
        logger: silentLogger,
      },
      // What is thrown is named by its type, never quoted.
      {
        access: {
          operation: "subscriberFailures.list",
          actor: null,
          persons: [],
          personCount: 0,
          at: "2026-03-01T10:00:00.000Z",
          outcome: "refused",
          errorName: "string",
          errorCode: null,
          restricted: null,
          detail: { failures: 0 },
        },
        env: { KEY: "value" },
        tenant: DEFAULT_TENANT,
        logger: silentLogger,
      },
    ]);
  });
});

describe("recorded", () => {
  it("records ok after what it runs resolves, and hands its result out", async () => {
    const outcomes: unknown[] = [];
    const result = await recorded(
      async (outcome, error) => {
        outcomes.push(outcome, error);
      },
      async () => {
        outcomes.push("ran");
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(outcomes).toEqual(["ran", "ok", undefined]);
  });

  it("records failed before throwing the error on, and throws the record's own failure instead", async () => {
    const outcomes: unknown[] = [];
    const quoted = new Error("ana@example.com bounced");
    await expect(
      recorded(
        async (outcome, error) => {
          outcomes.push(outcome, error);
        },
        () => Promise.reject(quoted),
      ),
    ).rejects.toBe(quoted);
    expect(outcomes).toEqual(["failed", quoted]);
    const down = new Error("audit down");
    await expect(
      recorded(
        () => Promise.reject(down),
        () => Promise.reject(quoted),
      ),
    ).rejects.toBe(down);
    await expect(
      recorded(
        () => Promise.reject(down),
        async () => 42,
      ),
    ).rejects.toBe(down);
  });
});

describe("checked", () => {
  it("hands out what its check returns, recording nothing", async () => {
    const outcomes: unknown[] = [];
    const result = await checked(
      async (outcome, error) => {
        outcomes.push(outcome, error);
      },
      () => 42,
    );
    expect(result).toBe(42);
    expect(outcomes).toEqual([]);
  });

  it("records refused, with what its check threw, before throwing it on, and throws the record's own failure instead", async () => {
    const outcomes: unknown[] = [];
    const invalid = new Error("no person id");
    await expect(
      checked(
        async (outcome, error) => {
          outcomes.push(outcome, error);
        },
        () => Promise.reject(invalid),
      ),
    ).rejects.toBe(invalid);
    expect(outcomes).toEqual(["refused", invalid]);
    const down = new Error("audit down");
    await expect(
      checked(
        () => Promise.reject(down),
        () => Promise.reject(invalid),
      ),
    ).rejects.toBe(down);
  });
});
