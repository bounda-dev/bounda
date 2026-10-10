import { describe, expect, it } from "vitest";
import type { PendingEvent } from "../../adapter/storage/event-store.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { createGlobalStream, type GlobalStream, type ReadEventsArgs } from "./global-stream.ts";

const pending = (version: number): PendingEvent => ({
  id: `e-${version}`,
  aggregateType: "order",
  aggregateId: "o-1",
  version,
  type: "OrderNoted",
  payload: { note: version },
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: false },
});

const streamOf = async (count: number): Promise<GlobalStream> => {
  const { eventStore } = await memory().createStorage({ logger: silentLogger });
  await eventStore.append({
    aggregateType: "order",
    aggregateId: "o-1",
    expectedVersion: 0,
    events: Array.from({ length: count }, (_, index) => pending(index + 1)),
  });
  return createGlobalStream({ eventStore });
};

const positions = async (stream: GlobalStream, args?: ReadEventsArgs): Promise<number[]> =>
  (await stream.read(args)).map((event) => event.position);

const refusal = async (stream: GlobalStream, args: ReadEventsArgs): Promise<unknown> => {
  try {
    await stream.read(args);
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
};

const AFTER = { path: ["after"], message: "Expected a position: a whole number from 0" };
const LIMIT = { path: ["limit"], message: "Expected a whole number from 1 to 1000" };

describe("createGlobalStream", () => {
  it("reads the first 100 events unless told where to start and how many", async () => {
    const stream = await streamOf(101);
    expect(await positions(stream)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(await positions(stream, { after: 100 })).toEqual([101]);
    expect(await positions(stream, { after: 101 })).toEqual([]);
  });

  it("reads at most limit events after a position, the whole event each", async () => {
    const stream = await streamOf(5);
    expect(await stream.read({ after: 2, limit: 2 })).toEqual([
      { ...pending(3), position: 3 },
      { ...pending(4), position: 4 },
    ]);
    expect(await positions(stream, { after: 4, limit: 1 })).toEqual([5]);
    expect(await positions(stream, { after: 0, limit: 1_000 })).toEqual([1, 2, 3, 4, 5]);
    expect(await positions(stream, { after: Number.MAX_SAFE_INTEGER })).toEqual([]);
    expect(await positions(stream, null as unknown as ReadEventsArgs)).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses an after or a limit out of range, naming each", async () => {
    const stream = await streamOf(1);
    const refused = await refusal(stream, { after: -1, limit: 1_001 });
    expect(refused).toBeInstanceOf(ValidationError);
    expect(refused).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Invalid read of the global stream",
      issues: [AFTER, LIMIT],
    });
    for (const after of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1" as unknown as number]) {
      expect(await refusal(stream, { after })).toMatchObject({ issues: [AFTER] });
    }
    for (const limit of [0, 1_001, 2.5, Number.NaN, "10" as unknown as number]) {
      expect(await refusal(stream, { limit })).toMatchObject({ issues: [LIMIT] });
    }
  });
});
