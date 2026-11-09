import { describe, expect, it } from "vitest";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import {
  createRestoreWatch,
  GENERATION_INTERVAL_MS,
  RESTORE_GENERATION,
  RESTORES_FOUND,
} from "./restores.ts";

const at = (ms: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + ms);

describe("createRestoreWatch", () => {
  it("moves the generation at most once an interval", async () => {
    const { checkpointStore } = await memory().createStorage();
    const { logger } = createRecordingLogger("omit");
    const watch = createRestoreWatch({ checkpoints: checkpointStore, logger });
    await watch.check(at(0));
    await watch.check(at(GENERATION_INTERVAL_MS - 1));
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    await watch.check(at(GENERATION_INTERVAL_MS));
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(2);
  });

  it("counts a restore once when two instances find it at the same moment, and then nothing more", async () => {
    const { checkpointStore } = await memory().createStorage();
    const { logger } = createRecordingLogger("omit");
    const one = createRestoreWatch({ checkpoints: checkpointStore, logger });
    const other = createRestoreWatch({ checkpoints: checkpointStore, logger });
    await one.check(at(0));
    await other.check(at(0));
    await checkpointStore.set(RESTORE_GENERATION, 0);
    const found = await Promise.all([one.check(at(1)), other.check(at(1))]);
    expect(found.map((each) => each?.first).sort()).toEqual([false, true]);
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await Promise.all([one.check(at(2)), other.check(at(2))])).toEqual([null, null]);
  });

  it("logs a store it could not read, and finds nothing", async () => {
    const { checkpointStore } = await memory().createStorage();
    const { logger, entries } = createRecordingLogger("omit");
    const failing: CheckpointStore = {
      ...checkpointStore,
      get: () => Promise.reject(new Error("store is down")),
    };
    const watch = createRestoreWatch({ checkpoints: failing, logger });
    expect(await watch.check(at(0))).toBeNull();
    expect(entries).toEqual([
      {
        level: "error",
        message: "the database could not be checked for a restore",
        fields: expect.objectContaining({ errorName: "Error" }),
      },
    ]);
  });
});
