import { describe, expect, it } from "vitest";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import {
  createRestoreWatch,
  GENERATION_INTERVAL_MS,
  MARK_INTERVAL_MS,
  RESTORE_GENERATION,
  RESTORE_MARK,
  RESTORES_FOUND,
} from "./restores.ts";

const at = (ms: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + ms);

const setUp = async (
  options: {
    readonly marks?: boolean;
    readonly wrap?: (store: CheckpointStore) => CheckpointStore;
    readonly ledger?: (ledger: ForgetLedger) => Pick<ForgetLedger, "readMark" | "raiseMark">;
  } = {},
) => {
  const { checkpointStore } = await memory().createStorage();
  const ledger = await memory().createForgetLedger({});
  const { logger, entries } = createRecordingLogger("omit");
  const stream = { head: 0 };
  const watchOver = () =>
    createRestoreWatch({
      checkpoints: options.wrap?.(checkpointStore) ?? checkpointStore,
      events: { lastPosition: async () => stream.head },
      marks: options.marks === false ? null : (options.ledger?.(ledger) ?? ledger),
      logger,
    });
  return { checkpointStore, ledger, entries, stream, watchOver };
};

describe("createRestoreWatch", () => {
  it("moves the generation at most once an interval", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    const watch = watchOver();
    await watch.check(at(0), { active: true });
    await watch.check(at(GENERATION_INTERVAL_MS - 1), { active: true });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    await watch.check(at(GENERATION_INTERVAL_MS));
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(2);
  });

  it("counts a restore once when two instances find it at the same moment, and then nothing more", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    const one = watchOver();
    const other = watchOver();
    await one.check(at(0), { active: true });
    await other.check(at(0), { active: true });
    await checkpointStore.set(RESTORE_GENERATION, 0);
    const found = await Promise.all([one.check(at(1)), other.check(at(1))]);
    expect(found.map((each) => each?.first).sort()).toEqual([false, true]);
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await Promise.all([one.check(at(2)), other.check(at(2))])).toEqual([null, null]);
  });

  it("logs a store it could not read, and finds nothing", async () => {
    const { entries, watchOver } = await setUp({
      marks: false,
      wrap: (store) => ({ ...store, get: () => Promise.reject(new Error("store is down")) }),
    });
    const watch = watchOver();
    expect(await watch.check(at(0))).toBeNull();
    expect(await watch.start(at(0))).toBeNull();
    expect(entries).toEqual([
      {
        level: "error",
        message: "the database could not be checked for a restore",
        fields: expect.objectContaining({ errorName: "Error" }),
      },
      {
        level: "error",
        message: "the database could not be compared with the forget ledger's mark",
        fields: expect.objectContaining({ errorName: "Error" }),
      },
    ]);
  });

  it("finds at start a copy restored while the app was stopped, from the ledger's mark", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    const running = watchOver();
    expect(await running.start(at(0))).toBeNull();
    const copy = await checkpointStore.get(RESTORE_GENERATION);
    await running.check(at(0), { active: true });
    await running.check(at(GENERATION_INTERVAL_MS), { active: true });
    await running.flush();
    expect(await ledger.readMark(RESTORE_MARK)).toBe(2);
    await checkpointStore.set(RESTORE_GENERATION, copy);
    const restarted = watchOver();
    expect(await restarted.start(at(MARK_INTERVAL_MS))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(3);
    expect(await ledger.readMark(RESTORE_MARK)).toBe(3);
    expect(await watchOver().start(at(MARK_INTERVAL_MS + 1))).toBeNull();
  });

  it("raises the mark as the generation moves, at most once a mark interval, and on a flush", async () => {
    const { ledger, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start(at(0));
    await watch.check(at(1), { active: true });
    expect(await ledger.readMark(RESTORE_MARK)).toBe(0);
    await watch.check(at(MARK_INTERVAL_MS), { active: true });
    expect(await ledger.readMark(RESTORE_MARK)).toBe(2);
    await watch.check(at(MARK_INTERVAL_MS + GENERATION_INTERVAL_MS), { active: true });
    expect(await ledger.readMark(RESTORE_MARK)).toBe(2);
    await watch.flush();
    expect(await ledger.readMark(RESTORE_MARK)).toBe(3);
  });

  it("compares with the mark later when the ledger could not be read at start, moving nothing meanwhile", async () => {
    let down = true;
    const { checkpointStore, ledger, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: (name) => (down ? Promise.reject(new Error("down")) : inner.readMark(name)),
        raiseMark: (name, value) => inner.raiseMark(name, value),
      }),
    });
    await ledger.raiseMark(RESTORE_MARK, 5);
    const watch = watchOver();
    expect(await watch.start(at(0))).toBeNull();
    expect(await watch.check(at(1), { active: true })).toBeNull();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(0);
    await watch.flush();
    expect(await ledger.readMark(RESTORE_MARK)).toBe(5);
    down = false;
    expect(await watch.check(at(2))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(6);
  });

  it("logs a mark it could not raise, and goes on", async () => {
    const { entries, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: (name) => inner.readMark(name),
        raiseMark: () => Promise.reject(new Error("down")),
      }),
    });
    const watch = watchOver();
    expect(await watch.start(at(0))).toBeNull();
    await watch.flush();
    expect(entries.map(({ message }) => message)).toEqual([
      "the forget ledger's mark could not be raised",
      "the forget ledger's mark could not be raised",
    ]);
  });

  it("declares a restore, the first, and raises the mark past it", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start(at(0));
    expect(await watch.declare()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    expect(await ledger.readMark(RESTORE_MARK)).toBe(1);
  });

  it("touches no ledger and logs nothing without one", async () => {
    const { entries, watchOver } = await setUp({ marks: false });
    const watch = watchOver();
    expect(await watch.start(at(0))).toBeNull();
    await watch.check(at(1), { active: true });
    await watch.flush();
    expect(entries).toEqual([]);
  });

  it("raises nothing on a flush before the mark could be read", async () => {
    let raises = 0;
    const { watchOver } = await setUp({
      ledger: () => ({
        readMark: () => Promise.reject(new Error("down")),
        raiseMark: async () => {
          raises += 1;
        },
      }),
    });
    const watch = watchOver();
    await watch.start(at(0));
    await watch.flush();
    expect(raises).toBe(0);
  });

  it("declares a restore past the count it read, which the database may have taken back", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    const watch = watchOver();
    await checkpointStore.set(RESTORES_FOUND, 4);
    await watch.check(at(0));
    await checkpointStore.set(RESTORES_FOUND, 2);
    expect(await watch.declare()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(5);
  });
});
