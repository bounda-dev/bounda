import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { silentLogger } from "../../contracts/logger.ts";
import type { OnPersonalDataAccessArgs } from "../../modules/audit.ts";
import { createAccessLog, recorded } from "./access.ts";

describe("createAccessLog", () => {
  it("hands the hook the record, the environment and the logger, without a tenant for an app with one store, and waits for it", async () => {
    const received: OnPersonalDataAccessArgs[] = [];
    const record = createAccessLog({
      hook: async (args) => {
        await Promise.resolve();
        received.push(args);
      },
      env: { KEY: "value" },
      tenant: undefined,
      logger: silentLogger,
      clock: createFixedClock(new Date("2026-03-01T10:00:00.000Z")),
    });
    await record({
      operation: "deadLetters.get",
      detail: { letter: "dl-1" },
      actor: undefined,
      persons: ["ana", "bo", "ana"],
      outcome: "failed",
      unattributed: true,
    });
    await record({
      operation: "query",
      detail: { query: "getCustomer", readModel: "customers" },
      actor: "agent-7",
      persons: [],
      outcome: "ok",
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
          detail: { letter: "dl-1" },
        },
        env: { KEY: "value" },
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
          unattributed: false,
          detail: { query: "getCustomer", readModel: "customers" },
        },
        env: { KEY: "value" },
        logger: silentLogger,
      },
    ]);
  });
});

describe("recorded", () => {
  it("records ok after what it runs resolves, and hands its result out", async () => {
    const outcomes: string[] = [];
    const result = await recorded(
      async (outcome) => {
        outcomes.push(outcome);
      },
      async () => {
        outcomes.push("ran");
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(outcomes).toEqual(["ran", "ok"]);
  });

  it("records failed before throwing the error on, and throws the record's own failure instead", async () => {
    const outcomes: string[] = [];
    const quoted = new Error("ana@example.com bounced");
    await expect(
      recorded(
        async (outcome) => {
          outcomes.push(outcome);
        },
        () => Promise.reject(quoted),
      ),
    ).rejects.toBe(quoted);
    expect(outcomes).toEqual(["failed"]);
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
