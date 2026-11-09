import { describe, expect, it } from "vitest";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import { createLease, LEASE_MS } from "./lease.ts";

const start = Date.parse("2026-01-01T00:00:00.000Z");

const setUp = async (wrap: (store: CheckpointStore) => CheckpointStore = (store) => store) => {
  const { checkpointStore } = await memory().createStorage();
  const writes: number[] = [];
  const counted: CheckpointStore = {
    ...checkpointStore,
    compareAndSet: (row, expected, position) => {
      writes.push(position);
      return checkpointStore.compareAndSet(row, expected, position);
    },
  };
  const { logger, entries } = createRecordingLogger("omit");
  const clock = createFixedClock(new Date(start));
  const lease = createLease({ checkpoints: wrap(counted), row: "job:lease", clock, logger });
  return { checkpointStore, writes, lease, entries, clock };
};

describe("createLease", () => {
  it("renews only once half of it is spent, writing nothing before", async () => {
    const { lease, writes } = await setUp();
    expect(await lease.take(start)).toBe(true);
    expect(await lease.take(start + LEASE_MS / 2 - 1)).toBe(true);
    expect(await lease.take(start + LEASE_MS / 2)).toBe(true);
    expect(writes).toEqual([start + LEASE_MS, start + LEASE_MS / 2 + LEASE_MS]);
  });

  it("takes a lease written more than a lease ahead, by a clock that runs ahead", async () => {
    const { lease, checkpointStore } = await setUp();
    await checkpointStore.set("job:lease", start + LEASE_MS + 1);
    expect(await lease.take(start)).toBe(true);
    expect(await checkpointStore.get("job:lease")).toBe(start + LEASE_MS);
    await checkpointStore.set("job:lease", start + 2 * LEASE_MS);
    lease.reset();
    expect(await lease.take(start + LEASE_MS)).toBe(false);
    expect(lease.heldElsewhereUntil()).toBe(start + 2 * LEASE_MS);
  });

  it("gives back nothing it does not hold, and logs a lease it could not give back", async () => {
    let refusing = false;
    const { lease, writes, entries } = await setUp((store) => ({
      ...store,
      compareAndSet: (row, expected, position) =>
        refusing
          ? Promise.reject(new Error("cannot write"))
          : store.compareAndSet(row, expected, position),
    }));
    await lease.release();
    expect(writes).toEqual([]);
    expect(await lease.take(start)).toBe(true);
    refusing = true;
    await lease.release();
    expect(entries).toEqual([
      {
        level: "error",
        message: "background job could not give its lease back",
        fields: expect.objectContaining({ lease: "job:lease", errorName: "Error" }),
      },
    ]);
    await lease.release();
    expect(entries).toHaveLength(1);
  });
});
