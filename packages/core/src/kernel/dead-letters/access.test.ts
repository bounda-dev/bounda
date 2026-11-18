import { describe, expect, it } from "vitest";
import { testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { RecordAccessArgs } from "../personal-data/access.ts";
import type { ProcessDeadLetters } from "../process/dead-letter-retry.ts";
import { tracer } from "../telemetry.ts";
import { withPersonalKeys } from "../test-support.ts";
import { createDeadLetters } from "./dead-letters.ts";
import type { DeadLetterRetry } from "./retry.ts";

interface Recorded {
  readonly operation: string;
  readonly detail: unknown;
  readonly persons: RecordAccessArgs<"deadLetters.get">["persons"];
}

describe("the access log of dead letters", () => {
  it("names the person a letter's error is sealed under and those its payload holds, and nobody for a letter that names none", async () => {
    const storage = withPersonalKeys(await memory().createStorage());
    await storage.deadLetterStore.add({ ...testDeadLetter("dl-1"), person: "ana" });
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-2"),
      kind: "scheduled",
      firstFailedAt: "2026-01-01T00:01:00.000Z",
      persons: [
        { person: "bo", fingerprint: "f-bo" },
        { person: "cy", fingerprint: "f-cy" },
      ],
    });
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-3"),
      firstFailedAt: "2026-01-01T00:02:00.000Z",
    });
    const recorded: Recorded[] = [];
    const deadLetters = createDeadLetters({
      tracer,
      storage,
      retries: {} as DeadLetterRetry,
      processes: {} as Pick<ProcessDeadLetters, "parkedBehind" | "stillParked" | "abandon">,
      clock: createFixedClock(),
      logger: silentLogger,
      errorText: "omit",
      actor: "operator-1",
      recordAccess: async (args) => {
        recorded.push(args);
      },
    });

    expect(await deadLetters.list()).toHaveLength(3);
    await deadLetters.get("dl-2");
    await deadLetters.get("dl-3");
    expect(
      recorded.map(({ operation, persons, detail }) => ({ operation, persons, detail })),
    ).toEqual([
      { operation: "deadLetters.list", persons: ["ana", "bo", "cy"], detail: { letters: 3 } },
      { operation: "deadLetters.get", persons: ["bo", "cy"], detail: { letter: "dl-2" } },
      { operation: "deadLetters.get", persons: [], detail: { letter: "dl-3" } },
    ]);
  });

  it("records a read it refuses once read as failed, and hands nothing out", async () => {
    const storage = withPersonalKeys(await memory().createStorage());
    await storage.deadLetterStore.add({ ...testDeadLetter("dl-1"), person: "ana" });
    const outcomes: unknown[] = [];
    const deadLetters = createDeadLetters({
      tracer,
      storage,
      retries: {} as DeadLetterRetry,
      processes: {} as Pick<ProcessDeadLetters, "parkedBehind" | "stillParked" | "abandon">,
      clock: createFixedClock(),
      logger: silentLogger,
      errorText: "omit",
      recordAccess: async ({ operation, outcome }) => {
        outcomes.push([operation, outcome]);
      },
      vouch: async () => {
        throw new Error("restored");
      },
    });
    await expect(deadLetters.list()).rejects.toThrow("restored");
    await expect(deadLetters.get("dl-1")).rejects.toThrow("restored");
    expect(outcomes).toEqual([
      ["deadLetters.list", "failed"],
      ["deadLetters.get", "failed"],
    ]);
  });
});
