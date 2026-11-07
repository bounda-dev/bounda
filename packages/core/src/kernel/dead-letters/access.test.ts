import { describe, expect, it } from "vitest";
import { testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { RecordAccessArgs } from "../personal-data/access.ts";
import type { ProcessDeadLetters } from "../process/dead-letter-retry.ts";
import { createDeadLetters } from "./dead-letters.ts";
import type { DeadLetterRetry } from "./retry.ts";

describe("the access log of dead letters", () => {
  it("names the person a letter's error is sealed under and those its payload holds, and nobody for a letter that names none", async () => {
    const storage = await memory().createStorage();
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
    const recorded: RecordAccessArgs<"deadLetters.list" | "deadLetters.get">[] = [];
    const deadLetters = createDeadLetters({
      storage,
      retries: {} as DeadLetterRetry,
      processes: {} as Pick<ProcessDeadLetters, "parkedBehind" | "stillParked">,
      clock: createFixedClock(),
      logger: silentLogger,
      actor: "operator-1",
      recordAccess: async (args) => {
        recorded.push(args as RecordAccessArgs<"deadLetters.list" | "deadLetters.get">);
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
});
