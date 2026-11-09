import { describe, expect, it } from "vitest";
import { testMetadata } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { createPersonalKeyWrapping } from "../personal-data/wrapped-keys.ts";
import { createRecordingLogger } from "../test-support.ts";
import { createLastFailures } from "./last-failures.ts";

const event: StoredEvent = {
  id: "e-1",
  aggregateType: "order",
  aggregateId: "o-1",
  version: 1,
  position: 4,
  type: "OrderPlaced",
  payload: {},
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: testMetadata,
  person: null,
};

const setUp = async () => {
  const storage = await memory().createStorage();
  const { logger, entries } = createRecordingLogger("omit");
  const keys = createPersonalKeyWrapping({
    wrapper: null,
    clock: createFixedClock(),
  }).over(storage.personalKeys);
  const failing = {
    ...storage.subscriberFailures,
    record: () => Promise.reject(new Error("store is down")),
    resolve: () => Promise.reject(new Error("store is down")),
  };
  const lastFailures = createLastFailures({
    store: failing,
    aggregates: buildAggregates({ registry: { aggregates: {}, readModels: {} }, ports: {} }),
    keys,
    logger,
  });
  return { lastFailures, entries };
};

describe("createLastFailures", () => {
  it("logs a failure it could not record or resolve, and never rejects", async () => {
    const { lastFailures, entries } = await setUp();
    const at = new Date("2026-01-01T00:00:00.000Z");
    await lastFailures.record({ subscriber: "projection:x", event, error: new Error("boom"), at });
    await lastFailures.resolve("projection:x", at);
    expect(entries).toEqual([
      {
        level: "error",
        message: "subscriber failure could not be recorded",
        fields: expect.objectContaining({ subscriber: "projection:x", errorName: "Error" }),
      },
      {
        level: "error",
        message: "subscriber failure could not be marked resolved",
        fields: expect.objectContaining({ subscriber: "projection:x", errorName: "Error" }),
      },
    ]);
  });
});
