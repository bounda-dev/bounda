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
      persons: storage.persons,
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

  it("records the basis named even when the read fails", async () => {
    const storage = await memory().createStorage();
    await storage.subscriberFailures.record({
      subscriber: "projection:a",
      position: 1,
      eventId: "e-1",
      eventType: "CustomerRegistered",
      person: "ana",
      errorName: "Error",
      errorMessage: "cannot project ana",
      failedAt: "2026-01-01T00:00:00.000Z",
    });
    const records: unknown[] = [];
    const failures = createSubscriberFailures({
      store: storage.subscriberFailures,
      keys: createPersonalKeyWrapping({ wrapper: null, clock: createFixedClock() }).over(
        storage.personalKeys,
      ),
      persons: {
        restrictions: async () => {
          throw new Error("down");
        },
      },
      actor: undefined,
      recordAccess: async ({ outcome, restricted }) => {
        records.push({ outcome, restricted });
      },
      errorText: "omit",
    });
    await expect(failures.list({ includeRestricted: "legal-claims" })).rejects.toThrow("down");
    await expect(failures.get("projection:a", { includeRestricted: "consent" })).rejects.toThrow(
      "down",
    );
    expect(records).toEqual([
      { outcome: "failed", restricted: { basis: "legal-claims", persons: [] } },
      { outcome: "failed", restricted: { basis: "consent", persons: [] } },
    ]);
  });

  it("keeps the text of a failure about a restricted person sealed, opening it on a basis of article 18(2), recorded with them", async () => {
    const storage = await memory().createStorage();
    const failed = (subscriber: string, person: string | null, stack?: string) =>
      storage.subscriberFailures.record({
        subscriber,
        position: 1,
        eventId: `e-${subscriber}`,
        eventType: "CustomerRegistered",
        person,
        errorName: "Error",
        errorMessage: `cannot project ${person ?? "anyone"}`,
        ...(stack === undefined ? {} : { errorStack: stack }),
        failedAt: "2026-01-01T00:00:00.000Z",
      });
    await failed("projection:a", "ana", "Error: at a");
    await failed("projection:b", "bo");
    await failed("projection:c", null);
    await storage.persons.restrict("ana", {
      ground: "accuracy-contested",
      categories: ["marketing"],
      since: new Date("2026-01-02T00:00:00.000Z"),
    });
    await storage.persons.restrict("bo", {
      ground: "legal-claims",
      categories: null,
      since: new Date("2026-01-02T00:00:00.000Z"),
    });
    const records: { readonly persons: readonly string[]; readonly restricted: unknown }[] = [];
    const failures = createSubscriberFailures({
      store: storage.subscriberFailures,
      keys: createPersonalKeyWrapping({ wrapper: null, clock: createFixedClock() }).over(
        storage.personalKeys,
      ),
      persons: storage.persons,
      actor: undefined,
      recordAccess: async ({ persons, restricted = null }) => {
        records.push({
          persons: [...persons],
          restricted:
            restricted === null ? null : { ...restricted, persons: [...restricted.persons] },
        });
      },
      errorText: "omit",
    });
    expect(await failures.list()).toEqual([
      expect.objectContaining({
        subscriber: "projection:a",
        errorMessage: null,
        errorStack: null,
        restricted: true,
      }),
      expect.objectContaining({ subscriber: "projection:b", errorMessage: null, restricted: true }),
      expect.objectContaining({
        subscriber: "projection:c",
        errorMessage: "cannot project anyone",
      }),
    ]);
    expect((await failures.list())[1]).not.toHaveProperty("errorStack");
    expect((await failures.list())[2]).not.toHaveProperty("restricted");
    expect(
      await failures.get("projection:a", { includeRestricted: "legal-obligation" }),
    ).toMatchObject({
      errorMessage: null,
      restricted: true,
    });
    const opened = await failures.list({ includeRestricted: "consent" });
    expect(opened.map(({ errorMessage }) => errorMessage)).toEqual([
      "cannot project ana",
      "cannot project bo",
      "cannot project anyone",
    ]);
    expect(opened[0]).toMatchObject({ errorStack: "Error: at a" });
    expect(opened[0]).not.toHaveProperty("restricted");
    expect(
      await failures.get("projection:b", { includeRestricted: "public-interest" }),
    ).toMatchObject({
      errorMessage: "cannot project bo",
    });
    expect(records).toEqual([
      { persons: ["ana", "bo"], restricted: null },
      { persons: ["ana", "bo"], restricted: null },
      { persons: ["ana", "bo"], restricted: null },
      { persons: ["ana"], restricted: { basis: "legal-obligation", persons: [] } },
      { persons: ["ana", "bo"], restricted: { basis: "consent", persons: ["ana", "bo"] } },
      { persons: ["bo"], restricted: { basis: "public-interest", persons: ["bo"] } },
    ]);
    await expect(failures.list({ includeRestricted: "curiosity" as never })).rejects.toThrow(
      "subscriberFailures.list names a basis restricted data is not read on",
    );
    await expect(
      failures.get("projection:a", { includeRestricted: "curiosity" as never }),
    ).rejects.toThrow("subscriberFailures.get names a basis restricted data is not read on");
  });
});
