import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { createPersonalKeyWrapping } from "../personal-data/wrapped-keys.ts";
import { createSubscriberFailures } from "./subscriber-failures.ts";

describe("createSubscriberFailures", () => {
  it("names no person for a failure on an event that names nobody, and keeps a failure without a stack so", async () => {
    const storage = await memory().createStorage();
    await storage.subscriberFailures.record({
      subscriber: "projection:x",
      position: 1,
      eventId: "e-1",
      eventType: "OrderPlaced",
      person: null,
      errorName: "TypeError",
      errorMessage: "x is not a function",
      failedAt: "2026-01-01T00:00:00.000Z",
    });
    const records: { readonly operation: string; readonly persons: Iterable<string> }[] = [];
    const failures = createSubscriberFailures({
      store: storage.subscriberFailures,
      keys: createPersonalKeyWrapping({ wrapper: null, clock: createFixedClock() }).over(
        storage.personalKeys,
      ),
      actor: "ops-1",
      recordAccess: async ({ operation, persons }) => {
        records.push({ operation, persons });
      },
      errorText: "omit",
    });
    const [listed] = await failures.list();
    expect(listed).toMatchObject({ person: null, errorMessage: "x is not a function" });
    expect(listed).not.toHaveProperty("errorStack");
    expect(await failures.get("projection:x")).not.toHaveProperty("errorStack");
    expect(records.map(({ operation, persons }) => [operation, [...persons]])).toEqual([
      ["subscriberFailures.list", []],
      ["subscriberFailures.get", []],
    ]);
  });
});
