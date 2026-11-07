import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { silentLogger } from "../../contracts/logger.ts";
import type { OnPersonalDataAccessArgs } from "../../modules/audit.ts";
import { createAccessLog } from "./access.ts";

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
    });
    expect(received).toStrictEqual([
      {
        access: {
          operation: "deadLetters.get",
          actor: null,
          persons: ["ana", "bo"],
          personCount: 2,
          at: "2026-03-01T10:00:00.000Z",
          detail: { letter: "dl-1" },
        },
        env: { KEY: "value" },
        logger: silentLogger,
      },
    ]);
  });
});
