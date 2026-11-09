import { describe, expect, it } from "vitest";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import {
  createRestoreWatch,
  GENERATION_INTERVAL_MS,
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
      events: { lastPosition: async () => stream.head, readAll: async () => [] },
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
    expect(await watch.start()).toBeNull();
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
    expect(await running.start()).toBeNull();
    const copy = await checkpointStore.get(RESTORE_GENERATION);
    await running.check(at(0), { active: true });
    await running.check(at(GENERATION_INTERVAL_MS), { active: true });
    await running.flush();
    expect(await ledger.readMark(RESTORE_MARK)).toBe(2);
    await checkpointStore.set(RESTORE_GENERATION, copy);
    const restarted = watchOver();
    expect(await restarted.start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(3);
    expect(await ledger.readMark(RESTORE_MARK)).toBe(3);
    expect(await watchOver().start()).toBeNull();
  });

  it("raises the mark with every move of the generation, and moves it on a stop after recent writes", async () => {
    const { ledger, stream, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await watch.check(at(1), { active: true });
    expect(await ledger.readMark(RESTORE_MARK)).toBe(1);
    await watch.check(at(2), { active: true });
    expect(await ledger.readMark(RESTORE_MARK)).toBe(1);
    await watch.flush();
    expect(await ledger.readMark(RESTORE_MARK)).toBe(2);
    await watch.flush();
    expect(await ledger.readMark(RESTORE_MARK)).toBe(2);
    stream.head = 4;
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
    expect(await watch.start()).toBeNull();
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
    expect(await watch.start()).toBeNull();
    await watch.flush();
    expect(entries.map(({ message }) => message)).toEqual([
      "the forget ledger's mark could not be raised",
      "the forget ledger's mark could not be raised",
    ]);
  });

  it("declares a restore, the first, and raises the mark past it", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    expect(await watch.declare()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    expect(await ledger.readMark(RESTORE_MARK)).toBe(1);
  });

  it("touches no ledger and logs nothing without one", async () => {
    const { entries, watchOver } = await setUp({ marks: false });
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
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
    await watch.start();
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

  it("moves nothing on a stop without a write since the last move, and logs a stream it cannot read", async () => {
    let down = false;
    const { checkpointStore } = await memory().createStorage();
    const ledger = await memory().createForgetLedger({});
    const { logger, entries } = createRecordingLogger("omit");
    const watch = createRestoreWatch({
      checkpoints: checkpointStore,
      events: {
        lastPosition: async () => {
          if (down) throw new Error("down");
          return 0;
        },
        readAll: async () => [],
      },
      marks: ledger,
      logger,
    });
    await watch.start();
    await watch.check(at(0), { active: true });
    await watch.flush();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    down = true;
    await watch.flush();
    expect(entries.map(({ message }) => message)).toEqual([
      "the database could not be checked for a restore",
    ]);
  });
});

// A stream whose history a test rewrites, as a restore does: positions come back with other ids.
const rewritable = () => {
  let events: { id: string; position: number }[] = [];
  let reads = 0;
  return {
    events: {
      lastPosition: async () => events.at(-1)?.position ?? 0,
      readAll: async ({ afterPosition, limit }: { afterPosition: number; limit: number }) => {
        reads += 1;
        return events
          .filter(({ position }) => position > afterPosition)
          .slice(0, limit) as unknown as StoredEvent[];
      },
    },
    append: (...ids: string[]) => {
      for (const id of ids) events.push({ id, position: (events.at(-1)?.position ?? 0) + 1 });
    },
    // Positions may skip, as a sequence does after a rollback.
    skip: (count: number) => {
      const last = events.at(-1)?.position ?? 0;
      events.push({ id: `skipped-${last}`, position: last + count + 1 });
    },
    restore: (count: number) => {
      events = events.slice(0, count);
    },
    reads: () => reads,
  };
};

const watchingEvents = async () => {
  const { checkpointStore } = await memory().createStorage();
  const stream = rewritable();
  const { logger } = createRecordingLogger("omit");
  const watch = createRestoreWatch({
    checkpoints: checkpointStore,
    events: stream.events,
    marks: null,
    logger,
  });
  return { checkpointStore, stream, watch };
};

describe("createRestoreWatch, watching the newest event", () => {
  it("finds nothing while events are only appended, whatever positions they skip", async () => {
    const { stream, watch } = await watchingEvents();
    await watch.start();
    stream.append("e-1", "e-2");
    expect(await watch.check(at(0))).toBeNull();
    stream.skip(4);
    expect(await watch.check(at(1))).toBeNull();
    expect(await watch.check(at(2))).toBeNull();
  });

  it("finds a restore that took the stream back past the newest event it saw, before the generation moved", async () => {
    const { checkpointStore, stream, watch } = await watchingEvents();
    stream.append("e-1");
    await watch.start();
    stream.append("e-2");
    await watch.check(at(0));
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    stream.append("e-3");
    // Within the interval: the generation does not move, the event does.
    await watch.check(at(1));
    stream.restore(2);
    expect(await watch.check(at(2))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await watch.check(at(3))).toBeNull();
  });

  it("finds a restore however much was written after it, as positions come back under other ids", async () => {
    const { stream, watch } = await watchingEvents();
    stream.append("e-1", "e-2");
    await watch.start();
    stream.restore(1);
    stream.append("e-2b", "e-3b");
    expect(await watch.check(at(0))).toEqual({ first: true });
    expect(await watch.check(at(1))).toBeNull();
    stream.restore(1);
    stream.append("e-2c");
    expect(await watch.check(at(2))).toEqual({ first: true });
    // Another event at the position it watched last: the restore is counted once.
    expect(await watch.check(at(3))).toBeNull();
  });

  it("watches the event at its position again after a restore that put another one there", async () => {
    const { stream, watch } = await watchingEvents();
    stream.append("e-1", "e-2");
    await watch.start();
    stream.restore(1);
    stream.append("e-2b");
    expect(await watch.check(at(0))).toEqual({ first: true });
    expect(await watch.check(at(1))).toBeNull();
  });

  it("finds a restore to an empty stream, and watches the stream again once events come", async () => {
    const { stream, watch } = await watchingEvents();
    stream.append("e-1");
    await watch.start();
    stream.restore(0);
    expect(await watch.check(at(0))).toEqual({ first: true });
    expect(await watch.check(at(1))).toBeNull();
    stream.append("e-1b");
    expect(await watch.check(at(2))).toBeNull();
    stream.restore(0);
    expect(await watch.check(at(3))).toEqual({ first: true });
  });

  it("watches an event it committed once it is newer than the one it read, and nothing older", async () => {
    const { stream, watch } = await watchingEvents();
    stream.append("e-1", "e-2");
    await watch.start();
    watch.saw({ id: "e-1", position: 1 });
    watch.saw({ id: "elsewhere", position: 2 });
    expect(await watch.check(at(0))).toBeNull();
    stream.append("forgotten");
    watch.saw({ id: "forgotten", position: 3 });
    stream.restore(2);
    expect(await watch.check(at(1))).toEqual({ first: true });
  });

  it("watches an event it committed before its first reading", async () => {
    const { stream, watch } = await watchingEvents();
    stream.append("e-1");
    watch.saw({ id: "e-1", position: 1 });
    stream.restore(0);
    await watch.check(at(0));
    expect(await watch.found()).toBe(0);
    stream.append("e-1b");
    watch.saw({ id: "e-1b", position: 1 });
    stream.restore(0);
    expect(await watch.check(at(1))).toEqual({ first: true });
  });

  it("watches the stream as it is after a restore was declared, so it is counted once", async () => {
    const { stream, watch } = await watchingEvents();
    stream.append("e-1", "e-2");
    await watch.start();
    stream.restore(1);
    expect(await watch.declare()).toEqual({ first: true });
    expect(await watch.check(at(0))).toBeNull();
    expect(await watch.found()).toBe(1);
  });

  it("reads the stream once a check while nothing is appended", async () => {
    const { stream, watch } = await watchingEvents();
    stream.append("e-1");
    await watch.start();
    const before = stream.reads();
    await watch.check(at(0));
    expect(stream.reads() - before).toBe(1);
    stream.append("e-2");
    await watch.check(at(1));
    expect(stream.reads() - before).toBe(3);
  });

  it("moves the generation at the next check for an active caller that joined one under way", async () => {
    const { checkpointStore, stream, watch } = await watchingEvents();
    stream.append("e-1");
    await watch.start();
    await Promise.all([watch.check(at(0)), watch.check(at(0), { active: true })]);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(0);
    await watch.check(at(1));
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
  });

  it("shares one check between callers that overlap, and checks again after", async () => {
    const { checkpointStore, stream, watch } = await watchingEvents();
    stream.append("e-1", "e-2");
    await watch.start();
    stream.restore(1);
    const found = await Promise.all([watch.check(at(0)), watch.check(at(0), { active: true })]);
    expect(found[0]).toEqual({ first: true });
    expect(found[1]).toBe(found[0]);
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await watch.check(at(1))).toBeNull();
  });
});
