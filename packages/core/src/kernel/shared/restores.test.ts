import { describe, expect, it } from "vitest";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { ForgetLedger, ForgetLedgerMark } from "../../adapter/storage/forget-ledger.ts";
import { fenceError } from "../../adapter/storage/tenant-fence.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { DEFAULT_TENANT } from "../personal-data/tenant-keys.ts";
import { createRecordingLogger } from "../test-support.ts";
import {
  createRestoreWatch,
  GENERATION_INTERVAL_MS,
  RESTORE_COUNT_MARK,
  RESTORE_COVERED,
  RESTORE_DECLARING,
  RESTORE_DECLARING_AT,
  RESTORE_GENERATION,
  RESTORE_HANDLED,
  RESTORE_MARK,
  RESTORE_RECOUNTED_MARK,
  RESTORE_UNCLAIMED,
  RESTORES_FOUND,
} from "./restores.ts";

const at = (ms: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + ms);

// A wait no test lets pass.
const never = () => () => undefined;

const highestOf = async (ledger: Pick<ForgetLedger, "readMark">, name: string): Promise<number> =>
  (await ledger.readMark(name))[0]?.value ?? 0;

const raiseTo = (ledger: Pick<ForgetLedger, "raiseMark">, name: string, value: number) =>
  ledger.raiseMark(name, { value, raisedAt: at(0).toISOString() });

const setUp = async (
  options: {
    readonly marks?: boolean;
    readonly wrap?: (store: CheckpointStore) => CheckpointStore;
    readonly ledger?: (ledger: ForgetLedger) => Pick<ForgetLedger, "readMark" | "raiseMark">;
  } = {},
) => {
  const { checkpointStore } = await memory().createStorage();
  const ledger = await memory().createForgetLedger({ tenant: DEFAULT_TENANT });
  const { logger, entries } = createRecordingLogger("omit");
  const stream = { head: 0 };
  const watchOver = () =>
    createRestoreWatch({
      checkpoints: options.wrap?.(checkpointStore) ?? checkpointStore,
      events: { lastPosition: async () => stream.head, readAll: async () => [] },
      marks: options.marks === false ? null : (options.ledger?.(ledger) ?? ledger),
      clock: { now: () => at(0), after: never },
      logger,
    });
  return { checkpointStore, ledger, entries, stream, watchOver };
};

// What `Adapter.restore` leaves: the copy counted past the database, for the first to take.
const restoredInPlace = async (store: CheckpointStore, restores: number) => {
  await store.set(RESTORES_FOUND, restores);
  await store.set(RESTORE_GENERATION, 7);
  await store.set(RESTORE_UNCLAIMED, restores);
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

  it("moves the generation past the mark on a restore found while running, so the next start counts it no more", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    for (let round = 0; round < 4; round += 1) {
      await watch.check(at(round * GENERATION_INTERVAL_MS), { active: true });
    }
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(4);
    // Another instance moved the generation further, and the mark with it.
    await raiseTo(ledger, RESTORE_MARK, 9);
    await checkpointStore.set(RESTORE_GENERATION, 1);
    expect(await watch.check(at(4 * GENERATION_INTERVAL_MS))).toEqual({ first: true });
    await watch.settled();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBeGreaterThan(9);
    expect(await watchOver().start()).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("counts a restore found while running though the mark cannot be read, and moves past the mark once it can", async () => {
    let down = false;
    const { checkpointStore, ledger, entries, stream, watchOver } = await setUp({
      ledger: (store) => ({
        readMark: async (name) => {
          if (down) throw new Error("ledger is down");
          return store.readMark(name);
        },
        raiseMark: (name, mark) => store.raiseMark(name, mark),
      }),
    });
    const watch = watchOver();
    await watch.start();
    for (let round = 0; round < 4; round += 1) {
      await watch.check(at(round * GENERATION_INTERVAL_MS), { active: true });
    }
    // Another instance moved the generation further, and the mark with it.
    await raiseTo(ledger, RESTORE_MARK, 9);
    await checkpointStore.set(RESTORE_GENERATION, 1);
    down = true;
    expect(await watch.check(at(4 * GENERATION_INTERVAL_MS))).toEqual({ first: true });
    expect(entries).toContainEqual({
      level: "error",
      message: "the forget ledger's mark could not be read",
      fields: expect.objectContaining({ errorName: "Error" }),
    });
    const counted = await checkpointStore.get(RESTORE_GENERATION);
    expect(counted).toBeLessThan(9);
    // Moved nowhere while the mark cannot be read: not by what handling the restore committed, a
    // stop, nor an active app.
    stream.head += 1;
    await watch.settled();
    await watch.flush();
    expect(await watch.check(at(5 * GENERATION_INTERVAL_MS), { active: true })).toBeNull();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(counted);
    down = false;
    expect(await watch.check(at(6 * GENERATION_INTERVAL_MS))).toBeNull();
    const lifted = await checkpointStore.get(RESTORE_GENERATION);
    expect(lifted).toBe(10);
    expect(await highestOf(ledger, RESTORE_MARK)).toBeLessThanOrEqual(lifted);
    // Down again, it moves nothing: a mark it cannot read may stand past the database.
    down = true;
    expect(await watch.check(at(7 * GENERATION_INTERVAL_MS), { active: true })).toBeNull();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(lifted);
    down = false;
    expect(await watch.check(at(8 * GENERATION_INTERVAL_MS))).toBeNull();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(lifted + 1);
    expect(await watchOver().start()).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("counts a restore made again while the mark could not be read, past the mark once it can", async () => {
    let down = false;
    const { checkpointStore, ledger, watchOver } = await setUp({
      ledger: (store) => ({
        readMark: async (name) => {
          if (down) throw new Error("ledger is down");
          return store.readMark(name);
        },
        raiseMark: (name, mark) => store.raiseMark(name, mark),
      }),
    });
    const watch = watchOver();
    await watch.start();
    for (let round = 0; round < 4; round += 1) {
      await watch.check(at(round * GENERATION_INTERVAL_MS), { active: true });
    }
    await raiseTo(ledger, RESTORE_MARK, 9);
    await checkpointStore.set(RESTORE_GENERATION, 1);
    down = true;
    await watch.check(at(4 * GENERATION_INTERVAL_MS));
    // Another copy put back before the ledger answers again.
    await checkpointStore.set(RESTORE_GENERATION, 0);
    down = false;
    expect(await watch.check(at(5 * GENERATION_INTERVAL_MS))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBeGreaterThan(9);
  });

  it("raises again, on the next check, a mark the ledger did not take, and nothing once it did", async () => {
    let refusing = true;
    let raises = 0;
    const { ledger, entries, watchOver } = await setUp({
      ledger: (store) => ({
        readMark: (name) => store.readMark(name),
        raiseMark: async (name, mark) => {
          raises += 1;
          if (refusing) throw new Error("ledger is down");
          await store.raiseMark(name, mark);
        },
      }),
    });
    const watch = watchOver();
    await watch.start();
    await watch.check(at(0), { active: true });
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(0);
    expect(entries.map(({ message }) => message)).toContain(
      "the forget ledger's mark could not be raised",
    );
    refusing = false;
    // Nothing written since: only the mark that failed is raised.
    await watch.check(at(1));
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(1);
    const raised = raises;
    await watch.check(at(2));
    expect(raises).toBe(raised);
  });

  it("keeps raising a mark it could not raise, though a lower one went through since", async () => {
    let refusing = false;
    const { checkpointStore, ledger, watchOver } = await setUp({
      ledger: (store) => ({
        readMark: (name) => store.readMark(name),
        raiseMark: async (name, mark) => {
          if (refusing) throw new Error("ledger is down");
          await store.raiseMark(name, mark);
        },
      }),
    });
    const watch = watchOver();
    await watch.start();
    await watch.check(at(0), { active: true });
    refusing = true;
    await watch.check(at(GENERATION_INTERVAL_MS), { active: true });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(2);
    refusing = false;
    // Another instance raised it lower meanwhile.
    await raiseTo(ledger, RESTORE_MARK, 1);
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(1);
    expect(await watch.check(at(2 * GENERATION_INTERVAL_MS))).toBeNull();
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(2);
  });

  it("counts a restore made in place past every restore the ledger counted, found at start or while running, once", async () => {
    for (const where of ["start", "check"] as const) {
      const { checkpointStore, ledger, watchOver } = await setUp();
      const watch = watchOver();
      await watch.start();
      await raiseTo(ledger, RESTORE_COUNT_MARK, 5);
      await restoredInPlace(checkpointStore, 2);
      const finding = where === "start" ? watchOver() : watch;
      const found =
        where === "start" ? await finding.start() : await finding.check(at(1), { active: true });
      expect(found).toEqual({ first: true });
      await finding.settled();
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(6);
      expect(await highestOf(ledger, RESTORE_COUNT_MARK)).toBe(6);
      if (where === "check") expect(await watch.check(at(2))).toBeNull();
    }
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

  it.each([true, false])(
    "finds at start a restore counted in place, and takes it once a start went through, counting it no more (ledger: %s)",
    async (marks) => {
      const { checkpointStore, watchOver } = await setUp({ marks });
      await restoredInPlace(checkpointStore, 3);
      // A start that fails before it went through leaves it for the next.
      expect(await watchOver().start()).toEqual({ first: true });
      const through = watchOver();
      expect(await through.start()).toEqual({ first: true });
      await through.settled();
      await through.settled();
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(3);
      expect(await checkpointStore.get(RESTORE_UNCLAIMED)).toBe(0);
      expect(await watchOver().start()).toBeNull();
    },
  );

  it("still counts at start a restore the ledger's mark tells, over a restore counted in place the copy held", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await restoredInPlace(checkpointStore, 3);
    await raiseTo(ledger, RESTORE_MARK, 20);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
    await watch.settled();
    expect(await watchOver().start()).toBeNull();
  });

  it("takes nothing once a start found nothing, and logs a store it could not take it in", async () => {
    const { checkpointStore, entries, watchOver } = await setUp({
      marks: false,
      wrap: (store) => ({
        ...store,
        compareAndSet: async (subscriber, expected, position) => {
          if (subscriber === RESTORE_UNCLAIMED) throw new Error("store is down");
          return store.compareAndSet(subscriber, expected, position);
        },
      }),
    });
    const nothing = watchOver();
    expect(await nothing.start()).toBeNull();
    await nothing.settled();
    expect(entries).toEqual([]);
    await restoredInPlace(checkpointStore, 2);
    const found = watchOver();
    await found.start();
    await found.settled();
    expect(entries).toEqual([
      expect.objectContaining({
        level: "error",
        message: "the restore handled could not be taken",
        fields: expect.objectContaining({ errorName: "Error" }),
      }),
    ]);
  });

  it("lets one running instance take a restore counted in place, the others finding it after", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    const one = watchOver();
    const other = watchOver();
    await one.check(at(0));
    await other.check(at(0));
    await restoredInPlace(checkpointStore, 1);
    const found = await Promise.all([one.check(at(1)), other.check(at(1))]);
    expect(found.map((each) => each?.first).sort()).toEqual([false, true]);
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("lets no running instance take a count a copy left behind, the restore it finds being another", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    const watch = watchOver();
    await watch.check(at(0));
    await checkpointStore.set(RESTORES_FOUND, 2);
    await checkpointStore.set(RESTORE_UNCLAIMED, 1);
    expect(await watch.check(at(1))).toEqual({ first: false });
    expect(await checkpointStore.get(RESTORE_UNCLAIMED)).toBe(1);
  });

  it("takes nothing a copy of an older count left behind", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    await checkpointStore.set(RESTORES_FOUND, 4);
    await checkpointStore.set(RESTORE_UNCLAIMED, 3);
    expect(await watchOver().start()).toBeNull();
    expect(await checkpointStore.get(RESTORE_UNCLAIMED)).toBe(3);
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
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(2);
    await checkpointStore.set(RESTORE_GENERATION, copy);
    const restarted = watchOver();
    expect(await restarted.start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(3);
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(3);
    expect(await watchOver().start()).toBeNull();
  });

  it("raises the mark with every move of the generation, and moves it on a stop after recent writes", async () => {
    const { ledger, stream, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await watch.check(at(1), { active: true });
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(1);
    await watch.check(at(2), { active: true });
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(1);
    await watch.flush();
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(2);
    await watch.flush();
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(2);
    stream.head = 4;
    await watch.flush();
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(3);
  });

  it("compares with the mark later when the ledger could not be read at start, moving nothing meanwhile", async () => {
    let down = true;
    const { checkpointStore, ledger, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: (name) => (down ? Promise.reject(new Error("down")) : inner.readMark(name)),
        raiseMark: (name, mark) => inner.raiseMark(name, mark),
      }),
    });
    await raiseTo(ledger, RESTORE_MARK, 5);
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    expect(await watch.check(at(1), { active: true })).toBeNull();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(0);
    await watch.flush();
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(5);
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
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(1);
  });

  it("touches no ledger and logs nothing without one, and moves on past a restore it found", async () => {
    const { checkpointStore, entries, watchOver } = await setUp({ marks: false });
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    await watch.check(at(1), { active: true });
    await watch.flush();
    await checkpointStore.set(RESTORE_GENERATION, 0);
    expect(await watch.check(at(2))).toEqual({ first: true });
    await watch.settled();
    const counted = await checkpointStore.get(RESTORE_GENERATION);
    await watch.check(at(2 + GENERATION_INTERVAL_MS), { active: true });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(counted + 1);
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
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(5);
  });

  it("moves nothing on a stop without a write since the last move, and logs a stream it cannot read", async () => {
    let down = false;
    const { checkpointStore } = await memory().createStorage();
    const ledger = await memory().createForgetLedger({ tenant: DEFAULT_TENANT });
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
      clock: { now: () => at(0), after: never },
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
    clock: { now: () => at(0), after: never },
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
    expect(await watch.declare()).toEqual({ first: true, counted: true });
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

describe("createRestoreWatch, declaring a restore", () => {
  it("raises the mark before it counts: a mark it cannot raise counts nothing", async () => {
    const { checkpointStore, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: (name) => inner.readMark(name),
        raiseMark: () => Promise.reject(new Error("down")),
      }),
    });
    await expect(watchOver().declare()).rejects.toThrow("down");
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(0);
    expect(await checkpointStore.get(RESTORE_DECLARING)).toBe(0);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(0);
  });

  it.each(["frozen", "forgotten"] as const)(
    "counts a declaration whose mark the ledger of a %s tenant refuses, which its next start raises",
    async (state) => {
      const { checkpointStore, watchOver } = await setUp({
        ledger: (inner) => ({
          readMark: (name) => inner.readMark(name),
          raiseMark: () =>
            Promise.reject(
              fenceError({ state, tenant: DEFAULT_TENANT, since: at(0).toISOString() }),
            ),
        }),
      });
      expect(await watchOver().declare()).toEqual({ first: true, counted: true });
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    },
  );

  it("moves the generation past the mark, which it raises to the same", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await raiseTo(ledger, RESTORE_MARK, 9);
    await checkpointStore.set(RESTORE_GENERATION, 4);
    await watchOver().declare();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(10);
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(10);
  });

  it("finishes a declaration that failed once its row was written, counting the restore once", async () => {
    let failing = true;
    const { checkpointStore, watchOver } = await setUp({
      wrap: (store) => ({
        ...store,
        compareAndSet: async (subscriber, expected, position) => {
          if (failing && subscriber === RESTORES_FOUND) throw new Error("store is down");
          return store.compareAndSet(subscriber, expected, position);
        },
      }),
    });
    await expect(watchOver().declare()).rejects.toThrow("store is down");
    expect(await checkpointStore.get(RESTORE_DECLARING)).toBe(1);
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(0);
    failing = false;
    const again = watchOver();
    expect(await again.declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    // Taken once handled, and declaring it again counts nothing more.
    expect(await checkpointStore.get(RESTORE_DECLARING)).toBe(1);
    await again.settled();
    expect(await checkpointStore.get(RESTORE_DECLARING)).toBe(0);
    expect(await watchOver().declare()).toEqual({ first: true, counted: false });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it.each([
    ["before it was counted", 0],
    ["once it was counted", 1],
  ])(
    "finishes at the next start a declaration that stopped %s, counting the restore once",
    async (_, counted) => {
      const { checkpointStore, ledger, watchOver } = await setUp();
      // The mark it raised first, and the generation it moved to before it wrote the row.
      await raiseTo(ledger, RESTORE_MARK, 1);
      await checkpointStore.set(RESTORE_GENERATION, 1);
      await checkpointStore.set(RESTORE_DECLARING, 1);
      await checkpointStore.set(RESTORES_FOUND, counted);
      const watch = watchOver();
      expect(await watch.start()).toEqual({ first: true });
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
      expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(2);
      await watch.settled();
      expect(await checkpointStore.get(RESTORE_DECLARING)).toBe(0);
      expect(await watchOver().start()).toBeNull();
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    },
  );

  it("leaves a declaration of an older count a copy held to the next, which counts past it", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    await checkpointStore.set(RESTORE_DECLARING, 2);
    await checkpointStore.set(RESTORES_FOUND, 3);
    expect(await watchOver().start()).toBeNull();
    await watchOver().declare();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
    expect(await checkpointStore.get(RESTORE_DECLARING)).toBe(4);
  });

  it("counts two declarations made at once as one", async () => {
    const { checkpointStore, watchOver } = await setUp();
    const declared = await Promise.all([watchOver().declare(), watchOver().declare()]);
    expect(declared).toEqual([
      { first: true, counted: true },
      { first: true, counted: true },
    ]);
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("declares again the restore it counted and has not settled, counting it once", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await raiseTo(ledger, RESTORE_MARK, 5);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("declares nothing more, for an operator, of a database that stands exactly where the last restore handled left it", async () => {
    const { checkpointStore, ledger, stream, watchOver } = await setUp();
    const first = watchOver();
    await first.start();
    await first.declare();
    stream.head = 2;
    await first.settled();
    expect(await checkpointStore.get(RESTORE_HANDLED)).not.toBe(0);
    const next = watchOver();
    await next.start();
    expect(await next.declare()).toEqual({ first: true, counted: false });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    // The same database once the generation moved, the mark with it: still where it was left.
    await next.check(at(0), { active: true });
    expect(await next.declare()).toEqual({ first: true, counted: false });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    // A copy of it taken before that move stands behind the mark.
    expect(await highestOf(ledger, RESTORE_MARK)).toBeGreaterThan(1);
    await checkpointStore.set(RESTORE_GENERATION, 1);
    expect(await watchOver().declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("raises the mark to the generation before it tells where the database stands, and rejects with a mark that cannot be raised", async () => {
    const { checkpointStore, ledger, stream, watchOver } = await setUp();
    await checkpointStore.set(RESTORE_GENERATION, 4);
    stream.head = 9;
    expect(await watchOver().reached()).toEqual({ generation: 4, position: 9 });
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(4);
    const failing = await setUp({
      ledger: (inner) => ({
        readMark: (name) => inner.readMark(name),
        raiseMark: async () => {
          throw new Error("the ledger is down");
        },
      }),
    });
    await expect(failing.watchOver().reached()).rejects.toThrow("the ledger is down");
    const unmarked = await setUp({ marks: false });
    await unmarked.checkpointStore.set(RESTORE_GENERATION, 2);
    expect(await unmarked.watchOver().reached()).toEqual({ generation: 2, position: 0 });
  });

  it("moves the generation of a declaration past a generation it is told the database reached, though the mark reads lower", async () => {
    const { checkpointStore, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    expect(await watch.declare({ reconciled: true, past: 8 })).toEqual({
      first: true,
      counted: true,
    });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(9);
    // A declaration a copy left under way, finished past it too.
    await checkpointStore.set(RESTORE_GENERATION, 9);
    await checkpointStore.set(RESTORE_DECLARING, 3);
    await checkpointStore.set(RESTORES_FOUND, 2);
    expect(await watchOver().declare({ reconciled: true, past: 12 })).toEqual({
      first: true,
      counted: true,
    });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(13);
  });

  it("counts, told again, an operator's declaration of a copy taken exactly when the last restore was handled", async () => {
    const { checkpointStore, stream, watchOver } = await setUp();
    const first = watchOver();
    await first.start();
    await first.declare();
    stream.head = 2;
    await first.settled();
    const next = watchOver();
    await next.start();
    expect(await next.declare({ again: true })).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
    await next.settled();
    // Where that one left it, a declaration made again counts nothing more.
    expect(await watchOver().declare()).toEqual({ first: true, counted: false });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("keeps where the last of two instances settling at once read the database, which a declaration made again finds", async () => {
    const { checkpointStore, ledger, stream, watchOver } = await setUp();
    const { logger } = createRecordingLogger("omit");
    const gated = () => {
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const atGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = false;
      const watch = createRestoreWatch({
        checkpoints: {
          get: (name) => checkpointStore.get(name),
          compareAndSet: async (name, expected, position) => {
            if (name === RESTORE_HANDLED && !held) {
              held = true;
              reached();
              await gate;
            }
            return checkpointStore.compareAndSet(name, expected, position);
          },
        },
        events: { lastPosition: async () => stream.head, readAll: async () => [] },
        marks: ledger,
        clock: { now: () => at(0), after: never },
        logger,
      });
      return { watch, atGate, release };
    };
    const stale = gated();
    const fresh = gated();
    await Promise.all([stale.watch.declare(), fresh.watch.declare()]);
    stream.head = 2;
    const settlingStale = stale.watch.settled();
    await stale.atGate;
    stream.head = 3;
    const settlingFresh = fresh.watch.settled();
    await fresh.atGate;
    // The one that read the database first writes first; the other writes after it, again.
    stale.release();
    await settlingStale;
    fresh.release();
    await settlingFresh;
    expect(await watchOver().declare()).toEqual({ first: true, counted: false });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("counts an operator's declaration of a database that moved on from where the last restore handled left it", async () => {
    const { checkpointStore, stream, watchOver } = await setUp();
    const first = watchOver();
    await first.start();
    await first.declare();
    await first.settled();
    stream.head = 4;
    expect(await watchOver().declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("counts, without a ledger, an operator's declaration of a copy taken after the last restore was handled", async () => {
    const { checkpointStore } = await memory().createStorage();
    const stream = rewritable();
    const watchOver = () =>
      createRestoreWatch({
        checkpoints: checkpointStore,
        events: stream.events,
        marks: null,
        clock: { now: () => at(0), after: never },
        logger: createRecordingLogger("omit").logger,
      });
    stream.append("e-1");
    const first = watchOver();
    await first.start();
    await first.declare();
    await first.settled();
    // Written to, copied, written to again, then put back to the copy while stopped.
    stream.append("e-2");
    stream.append("e-3");
    stream.restore(2);
    const next = watchOver();
    await next.start();
    expect(await next.declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("counts a restore the ledger tells, though the database stands where the last restore handled left it", async () => {
    const { checkpointStore, watchOver } = await setUp();
    const first = watchOver();
    await first.start();
    await first.declare();
    await first.settled();
    const next = watchOver();
    await next.start();
    expect(await next.declare({ reconciled: true })).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("counts a restore the ledger tells to an instance that has read nothing yet", async () => {
    const { checkpointStore, watchOver } = await setUp();
    await checkpointStore.set(RESTORES_FOUND, 1);
    expect(await watchOver().declare({ reconciled: true })).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("joins, for a restore the ledger tells, the one another instance counted since this one read", async () => {
    const { checkpointStore, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await checkpointStore.set(RESTORES_FOUND, 1);
    expect(await watch.declare({ reconciled: true })).toEqual({ first: false, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    // Read since: a later one counts.
    expect(await watch.declare({ reconciled: true })).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("tells a database apart by its newest event from where the last restore handled left it", async () => {
    const { checkpointStore } = await memory().createStorage();
    const stream = rewritable();
    const watchOver = () =>
      createRestoreWatch({
        checkpoints: checkpointStore,
        events: stream.events,
        marks: null,
        clock: { now: () => at(0), after: never },
        logger: createRecordingLogger("omit").logger,
      });
    stream.append("e-1");
    const first = watchOver();
    await first.start();
    await first.declare();
    await first.settled();
    // A copy of the same generation and count, whose stream went another way.
    stream.restore(0);
    stream.append("e-2");
    expect(await watchOver().declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("moves the generation and the mark past what handling the restore committed, once settled", async () => {
    const { checkpointStore, ledger, stream, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await watch.declare();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    stream.head = 3;
    await watch.settled();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(2);
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(2);
    // And a stop after it moves nothing more.
    await watch.flush();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(2);
  });

  it("settles a restore a running instance counted, and nothing one found but did not count", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    const one = watchOver();
    const other = watchOver();
    await one.check(at(0), { active: true });
    await other.check(at(0), { active: true });
    await checkpointStore.set(RESTORE_GENERATION, 0);
    await one.check(at(1));
    await one.settled();
    const handled = await checkpointStore.get(RESTORE_HANDLED);
    expect(handled).not.toBe(0);
    await other.check(at(1));
    await checkpointStore.set(RESTORE_HANDLED, 0);
    await other.settled();
    expect(await checkpointStore.get(RESTORE_HANDLED)).toBe(0);
  });

  it("settles a restore a running instance took in place, as one it handled", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    const watch = watchOver();
    await watch.check(at(0));
    await restoredInPlace(checkpointStore, 1);
    expect(await watch.check(at(1))).toEqual({ first: true });
    await watch.settled();
    expect(await checkpointStore.get(RESTORE_HANDLED)).not.toBe(0);
    expect(await watch.declare()).toEqual({ first: true, counted: false });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("moves nothing on settling a restore whose handling committed nothing", async () => {
    const { checkpointStore, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await watch.declare();
    await watch.settled();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
  });

  it("handles a restore counted in place that a start found though the ledger's mark could not be read, moving nothing on settling it", async () => {
    const { checkpointStore, stream, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: () => Promise.reject(new Error("down")),
        raiseMark: (name, mark) => inner.raiseMark(name, mark),
      }),
    });
    await restoredInPlace(checkpointStore, 1);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    stream.head = 3;
    await watch.settled();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(7);
    expect(await checkpointStore.get(RESTORE_UNCLAIMED)).toBe(0);
  });

  it("handles a restore a start counted from the mark though it could not raise the mark after", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: (name) => inner.readMark(name),
        raiseMark: () => Promise.reject(new Error("down")),
      }),
    });
    await raiseTo(ledger, RESTORE_MARK, 5);
    expect(await watchOver().start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("counts a later restore declared on the instance that settled the last, of a copy behind the mark", async () => {
    const { checkpointStore, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await watch.declare();
    await watch.settled();
    await checkpointStore.set(RESTORE_GENERATION, 0);
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("counts a copy taken while a declaration was under way as another restore, past it, and clears its row once handled", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    // The live database moved past the declaration the copy holds, and the mark with it.
    await raiseTo(ledger, RESTORE_MARK, 4);
    await checkpointStore.set(RESTORE_GENERATION, 2);
    await checkpointStore.set(RESTORE_DECLARING, 3);
    await checkpointStore.set(RESTORES_FOUND, 3);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
    await watch.settled();
    expect(await checkpointStore.get(RESTORE_DECLARING)).toBe(0);
  });

  it("declares past a declaration a copy brought back under a running instance", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await raiseTo(ledger, RESTORE_MARK, 4);
    await checkpointStore.set(RESTORE_GENERATION, 2);
    await checkpointStore.set(RESTORE_DECLARING, 3);
    await checkpointStore.set(RESTORES_FOUND, 2);
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(5);
  });

  it("leaves the generation where another instance moved it past the declaration's", async () => {
    let moving: () => Promise<void> = async () => undefined;
    const { checkpointStore, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: (name) => inner.readMark(name),
        raiseMark: async (name, mark) => {
          await inner.raiseMark(name, mark);
          await moving();
        },
      }),
    });
    moving = () => checkpointStore.set(RESTORE_GENERATION, 50);
    await watchOver().declare();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(50);
  });

  it("moves the generation past what it saw, without a ledger, when the database went back under it", async () => {
    const { checkpointStore, watchOver } = await setUp({ marks: false });
    await checkpointStore.set(RESTORE_GENERATION, 6);
    const watch = watchOver();
    await watch.start();
    await checkpointStore.set(RESTORE_GENERATION, 2);
    await watch.declare();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(7);
  });
});

describe("createRestoreWatch, with the count of restores in the ledger", () => {
  // A ledger whose raises of `failing` marks fail, recording every raise asked of it.
  const failingRaises = () => {
    const state = { failing: new Set<string>(), raised: [] as (readonly [string, number])[] };
    const ledger = (store: ForgetLedger) => ({
      readMark: (name: string) => store.readMark(name),
      raiseMark: async (name: string, mark: ForgetLedgerMark) => {
        state.raised.push([name, mark.value]);
        if (state.failing.has(name)) throw new Error("ledger is down");
        await store.raiseMark(name, mark);
      },
    });
    return { state, ledger };
  };

  it("joins, as another instance's, a count made since it read that took the number it read, and counts a copy holding that number counted earlier", async () => {
    for (const [covered, found, restores] of [
      [200, { first: false }, 1],
      [50, { first: true }, 2],
    ] as const) {
      const { checkpointStore, watchOver } = await setUp();
      await checkpointStore.set(RESTORES_FOUND, 1);
      await checkpointStore.set(RESTORE_COVERED, 100);
      const watch = watchOver();
      await watch.start();
      // Counted, or brought back, while the ledger could not say the latest count.
      await checkpointStore.set(RESTORE_COVERED, covered);
      expect(await watch.check(at(0))).toEqual(found);
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(restores);
    }
  });

  it("counts a database that holds fewer restores than the ledger counted, at the generation the mark says", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await raiseTo(ledger, RESTORE_MARK, 5);
    await raiseTo(ledger, RESTORE_COUNT_MARK, 3);
    await checkpointStore.set(RESTORE_GENERATION, 5);
    await checkpointStore.set(RESTORES_FOUND, 1);
    expect(await watchOver().start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
    // And a running instance, once the ledger counted past what it holds.
    const watch = watchOver();
    await watch.start();
    await raiseTo(ledger, RESTORE_COUNT_MARK, 6);
    expect(await watch.check(at(0))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(7);
  });

  it("takes a count made in place below the ledger's as the restore it is, once", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await raiseTo(ledger, RESTORE_COUNT_MARK, 3);
    await restoredInPlace(checkpointStore, 2);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    await watch.settled();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
    // What it took, and the time it took it at, read as its own.
    expect(await watch.check(at(0))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
  });

  it("raises no count the database does not hold, when another count took the row first", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp({
      wrap: (store) => ({
        ...store,
        compareAndSet: async (name, expected, next) => {
          // Another instance counts first, from the same row.
          if (name === RESTORES_FOUND && expected === 0) await store.set(RESTORES_FOUND, 1);
          return store.compareAndSet(name, expected, next);
        },
      }),
    });
    const watch = watchOver();
    await watch.start();
    await raiseTo(ledger, RESTORE_COUNT_MARK, 4);
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await highestOf(ledger, RESTORE_COUNT_MARK)).toBe(4);
  });

  it("counts a database that never counted a restore while the ledger counted some", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await raiseTo(ledger, RESTORE_COUNT_MARK, 2);
    expect(await watchOver().start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(3);
  });

  it("moves no generation in the check that joins another instance's count, so its reconciliation reads the database as the copy left it", async () => {
    const { checkpointStore, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await watch.check(at(0), { active: true });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    // Counted by another instance, which moved the generation past the copy's.
    await checkpointStore.set(RESTORES_FOUND, 1);
    await checkpointStore.set(RESTORE_COVERED, 100);
    expect(await watch.check(at(GENERATION_INTERVAL_MS), { active: true })).toEqual({
      first: false,
    });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    expect(await watch.check(at(2 * GENERATION_INTERVAL_MS))).toBeNull();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(2);
  });

  it("moves past a mark raised before the latest restore the database counted, counting nothing, and counts one raised since", async () => {
    for (const [raisedAt, found, generation] of [
      // At the very time of the count, above what it moved to: raised before it.
      [at(0), null, 6],
      [at(1), { first: true }, 6],
    ] as const) {
      const { checkpointStore, ledger, watchOver } = await setUp();
      await checkpointStore.set(RESTORES_FOUND, 1);
      await checkpointStore.set(RESTORE_COVERED, at(0).getTime());
      await checkpointStore.set(RESTORE_GENERATION, 2);
      // Raised by a stop, as a raise given up for its timeout lands, once the count went past it.
      await ledger.raiseMark(RESTORE_MARK, { value: 5, raisedAt: raisedAt.toISOString() });
      await ledger.raiseMark(RESTORE_COUNT_MARK, { value: 1, raisedAt: at(0).toISOString() });
      expect(await watchOver().start()).toEqual(found);
      expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(generation);
      expect(await highestOf(ledger, RESTORE_MARK)).toBe(6);
      const watch = watchOver();
      await watch.start();
      expect(await watch.check(at(1))).toBeNull();
    }
  });

  it("moves past no mark the database holds already, nor one raised before the latest restore it counted when the ledger counted past it", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await checkpointStore.set(RESTORES_FOUND, 1);
    await checkpointStore.set(RESTORE_COVERED, at(0).getTime());
    await checkpointStore.set(RESTORE_GENERATION, 5);
    await ledger.raiseMark(RESTORE_MARK, { value: 5, raisedAt: at(-1).toISOString() });
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    expect(await watch.check(at(0))).toBeNull();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(5);
    // Below a mark raised before, though the ledger counted a restore since that the copy lacks.
    await checkpointStore.set(RESTORE_GENERATION, 2);
    await ledger.raiseMark(RESTORE_COUNT_MARK, { value: 3, raisedAt: at(0).toISOString() });
    expect(await watch.check(at(1))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
  });

  it("moves past nothing while the mark cannot be read, whatever the last read showed", async () => {
    const state = { down: false };
    const { checkpointStore, ledger, watchOver } = await setUp({
      ledger: (store) => ({
        readMark: async (name) => {
          if (state.down) throw new Error("down");
          return store.readMark(name);
        },
        raiseMark: (name, mark) => store.raiseMark(name, mark),
      }),
    });
    await checkpointStore.set(RESTORES_FOUND, 1);
    await checkpointStore.set(RESTORE_COVERED, at(0).getTime());
    await checkpointStore.set(RESTORE_GENERATION, 5);
    await ledger.raiseMark(RESTORE_MARK, { value: 5, raisedAt: at(-1).toISOString() });
    const watch = watchOver();
    await watch.start();
    state.down = true;
    await checkpointStore.set(RESTORE_GENERATION, 6);
    await ledger.raiseMark(RESTORE_MARK, { value: 9, raisedAt: at(-1).toISOString() });
    expect(await watch.check(at(1))).toBeNull();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(6);
  });

  it("counts a copy holding fewer restores than it read, though the latest of those it holds was counted later, or at the same time on a ledger whose reads do not lag", async () => {
    for (const covered of [200, 100]) {
      const { checkpointStore, watchOver } = await setUp();
      await checkpointStore.set(RESTORES_FOUND, 2);
      await checkpointStore.set(RESTORE_COVERED, 100);
      const watch = watchOver();
      await watch.start();
      await checkpointStore.set(RESTORES_FOUND, 1);
      await checkpointStore.set(RESTORE_COVERED, covered);
      expect(await watch.check(at(0))).toEqual({ first: true });
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(3);
    }
  });

  it("keeps the time the instance that counted first counted at, not that of one that joined it", async () => {
    const { checkpointStore, ledger } = await setUp();
    const stream = { head: 0 };
    const watchAt = (ms: number) =>
      createRestoreWatch({
        checkpoints: checkpointStore,
        events: { lastPosition: async () => stream.head, readAll: async () => [] },
        marks: ledger,
        clock: { now: () => at(ms), after: never },
        logger: silentLogger,
      });
    const one = watchAt(1);
    const other = watchAt(5);
    await one.start();
    await other.start();
    await one.check(at(0), { active: true });
    await other.check(at(0));
    await checkpointStore.set(RESTORE_GENERATION, 0);
    const [first, second] = await Promise.all([one.check(at(1)), other.check(at(1))]);
    const counter = first?.first === true ? 1 : 5;
    expect([first?.first, second?.first].sort()).toEqual([false, true]);
    expect(await checkpointStore.get(RESTORE_COVERED)).toBe(at(counter).getTime());
  });

  it("raises past the generation it saw at stop when the database went back below it, its newest event still there", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await checkpointStore.set(RESTORE_GENERATION, 3);
    await watch.check(at(0));
    await checkpointStore.set(RESTORE_GENERATION, 1);
    await watch.flush();
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(4);
  });

  it("counts no database by a count the ledger raised before the latest restore it counted", async () => {
    for (const [raisedAt, found, restores] of [
      [at(-1), null, 1],
      [at(0), { first: true }, 4],
    ] as const) {
      const { checkpointStore, ledger, watchOver } = await setUp();
      await checkpointStore.set(RESTORES_FOUND, 1);
      await checkpointStore.set(RESTORE_COVERED, at(0).getTime());
      // Raised before a count that took a number already counted, as one made while the ledger
      // could not be read does.
      await ledger.raiseMark(RESTORE_COUNT_MARK, { value: 3, raisedAt: raisedAt.toISOString() });
      expect(await watchOver().start()).toEqual(found);
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(restores);
    }
  });

  it("moves a count made in place past a ledger's count raised before the latest restore the copy counted, and takes it as its own", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await restoredInPlace(checkpointStore, 2);
    await checkpointStore.set(RESTORE_COVERED, at(0).getTime());
    await ledger.raiseMark(RESTORE_COUNT_MARK, { value: 3, raisedAt: at(-1).toISOString() });
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    await watch.settled();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
    expect(await highestOf(ledger, RESTORE_COUNT_MARK)).toBe(4);
    expect(await watch.check(at(1))).toBeNull();
  });

  it("counts at start a copy below a mark raised before the latest restore it counted when the ledger counted a restore since that it lacks", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await checkpointStore.set(RESTORES_FOUND, 1);
    await checkpointStore.set(RESTORE_COVERED, at(0).getTime());
    await checkpointStore.set(RESTORE_GENERATION, 2);
    await ledger.raiseMark(RESTORE_MARK, { value: 5, raisedAt: at(-1).toISOString() });
    await ledger.raiseMark(RESTORE_COUNT_MARK, { value: 3, raisedAt: at(0).toISOString() });
    expect(await watchOver().start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
  });

  it("compares nothing with what the last read showed while the ledger cannot be read, raising nothing", async () => {
    const state = { down: false };
    const { checkpointStore, ledger, entries, watchOver } = await setUp({
      ledger: (store) => ({
        readMark: async (name) => {
          if (state.down) throw new Error("down");
          return store.readMark(name);
        },
        raiseMark: async (name, mark) => {
          if (state.down) throw new Error("down");
          await store.raiseMark(name, mark);
        },
      }),
    });
    await checkpointStore.set(RESTORES_FOUND, 3);
    await checkpointStore.set(RESTORE_COVERED, at(0).getTime());
    await checkpointStore.set(RESTORE_GENERATION, 5);
    await ledger.raiseMark(RESTORE_MARK, { value: 5, raisedAt: at(-1).toISOString() });
    await ledger.raiseMark(RESTORE_COUNT_MARK, { value: 3, raisedAt: at(0).toISOString() });
    const watch = watchOver();
    await watch.start();
    entries.splice(0);
    state.down = true;
    // A copy behind what the last read showed, of the mark and of the count.
    await checkpointStore.set(RESTORE_GENERATION, 2);
    await checkpointStore.set(RESTORES_FOUND, 1);
    expect(await watch.check(at(1))).toEqual({ first: true });
    expect(entries.map(({ message }) => message)).toEqual([
      "the forget ledger's mark could not be read",
      "the forget ledger's count of restores could not be raised",
    ]);
  });

  it("declares nothing more where handling the last restore left the database, below a mark raised before that restore was counted", async () => {
    const { checkpointStore, ledger, stream, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await watch.declare();
    stream.head = 1;
    await watch.settled();
    await ledger.raiseMark(RESTORE_MARK, { value: 9, raisedAt: at(-1).toISOString() });
    expect(await watch.declare()).toEqual({ first: true, counted: false });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("logs nothing about a count of restores without a ledger", async () => {
    const { checkpointStore, entries, watchOver } = await setUp({ marks: false });
    const watch = watchOver();
    await watch.check(at(0), { active: true });
    await checkpointStore.set(RESTORE_GENERATION, 0);
    expect(await watch.check(at(1))).toEqual({ first: true });
    expect(entries).toEqual([]);
  });

  it("raises again a count of restores the ledger did not take, once, and only that", async () => {
    const { state, ledger } = failingRaises();
    const { checkpointStore, entries, watchOver, ledger: store } = await setUp({ ledger });
    const watch = watchOver();
    await watch.start();
    await watch.check(at(0), { active: true });
    state.failing.add(RESTORE_COUNT_MARK);
    await checkpointStore.set(RESTORE_GENERATION, 0);
    expect(await watch.check(at(1))).toEqual({ first: true });
    expect(entries).toContainEqual({
      level: "error",
      message: "the forget ledger's count of restores could not be raised",
      fields: expect.objectContaining({ errorName: "Error" }),
    });
    state.failing.clear();
    state.raised.length = 0;
    await watch.check(at(2));
    expect(await highestOf(store, RESTORE_COUNT_MARK)).toBe(1);
    await watch.check(at(3));
    expect(state.raised.filter(([name]) => name === RESTORE_COUNT_MARK)).toEqual([
      [RESTORE_COUNT_MARK, 1],
    ]);
  });

  it("counts a restore made in place past a ledger's count that equals its own", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await raiseTo(ledger, RESTORE_COUNT_MARK, 2);
    await restoredInPlace(checkpointStore, 2);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    await watch.settled();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(3);
  });

  it("says a mark it cannot read once until it can again", async () => {
    let down = true;
    const { entries, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: (name) => (down ? Promise.reject(new Error("down")) : inner.readMark(name)),
        raiseMark: (name, mark) => inner.raiseMark(name, mark),
      }),
    });
    const watch = watchOver();
    await watch.start();
    await watch.check(at(1));
    const said = () =>
      entries.filter(({ message }) => message === "the forget ledger's mark could not be read");
    expect(said()).toHaveLength(1);
    down = false;
    await watch.check(at(2));
    down = true;
    await watch.check(at(3));
    expect(said()).toHaveLength(2);
  });

  it("declares a restore past the count the ledger holds", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await raiseTo(ledger, RESTORE_COUNT_MARK, 5);
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(6);
    expect(await highestOf(ledger, RESTORE_COUNT_MARK)).toBe(6);
  });

  it("counts a copy behind the mark past the count this instance read, though the ledger holds none", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await checkpointStore.set(RESTORES_FOUND, 2);
    const watch = watchOver();
    await watch.start();
    await raiseTo(ledger, RESTORE_MARK, 9);
    await checkpointStore.set(RESTORES_FOUND, 0);
    await checkpointStore.set(RESTORE_GENERATION, 1);
    expect(await watch.check(at(1))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(3);
  });
});

describe("createRestoreWatch, at start and at stop", () => {
  it("counts a copy behind the mark at a check before any start, and does nothing at a stop before it", async () => {
    const { checkpointStore, ledger, entries, watchOver } = await setUp();
    await watchOver().flush();
    expect(entries).toEqual([]);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(0);
    await raiseTo(ledger, RESTORE_MARK, 5);
    await checkpointStore.set(RESTORE_GENERATION, 1);
    expect(await watchOver().check(at(1))).toEqual({ first: true });
    expect(entries).toEqual([]);
  });

  it("finishes at start a declaration that did not, with a ledger and without", async () => {
    for (const marks of [true, false]) {
      const { checkpointStore, ledger, watchOver } = await setUp({ marks });
      await checkpointStore.set(RESTORE_DECLARING, 1);
      await checkpointStore.set(RESTORE_GENERATION, 3);
      await raiseTo(ledger, RESTORE_MARK, 3);
      expect(await watchOver().start()).toEqual({ first: true });
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    }
  });

  it("counts past a declaration a copy taken while it was under way, at start or once the mark reads", async () => {
    for (const down of [false, true]) {
      let unreadable = down;
      const { checkpointStore, ledger, watchOver } = await setUp({
        ledger: (inner) => ({
          readMark: (name) =>
            unreadable ? Promise.reject(new Error("down")) : inner.readMark(name),
          raiseMark: (name, mark) => inner.raiseMark(name, mark),
        }),
      });
      await checkpointStore.set(RESTORE_DECLARING, 1);
      await checkpointStore.set(RESTORE_GENERATION, 1);
      await raiseTo(ledger, RESTORE_MARK, 5);
      const watch = watchOver();
      const found = await watch.start();
      unreadable = false;
      if (down) expect(await watch.check(at(1))).toEqual({ first: true });
      else expect(found).toEqual({ first: true });
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
    }
  });

  it("raises at stop the mark past a database another instance moved, whose newest event this one committed is gone", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    watch.saw({ id: "e-1", position: 1 });
    await checkpointStore.set(RESTORE_GENERATION, 3);
    await raiseTo(ledger, RESTORE_MARK, 3);
    await watch.flush();
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(4);
    expect(await watchOver().start()).toEqual({ first: true });
  });

  it("moves at stop the generation after a write, and not past a mark it never compared", async () => {
    const { checkpointStore, ledger, stream, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    stream.head += 1;
    await watch.flush();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    expect(await highestOf(ledger, RESTORE_MARK)).toBe(1);
    const behind = watchOver();
    await behind.start();
    // Another instance's stop told the ledger of a copy this one sees nothing of.
    await raiseTo(ledger, RESTORE_MARK, 2);
    stream.head += 1;
    await behind.flush();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    expect(await watchOver().start()).toEqual({ first: true });
  });

  it("moves at stop past the mark a restore it counted while it could not read the mark", async () => {
    let down = false;
    const { checkpointStore, ledger, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: (name) => (down ? Promise.reject(new Error("down")) : inner.readMark(name)),
        raiseMark: (name, mark) => inner.raiseMark(name, mark),
      }),
    });
    const watch = watchOver();
    await watch.start();
    await watch.check(at(0), { active: true });
    await raiseTo(ledger, RESTORE_MARK, 9);
    await checkpointStore.set(RESTORE_GENERATION, 0);
    down = true;
    expect(await watch.check(at(1))).toEqual({ first: true });
    down = false;
    await watch.flush();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(10);
    expect(await watchOver().start()).toBeNull();
  });
});

describe("createRestoreWatch, on a ledger whose reads lag", () => {
  const LAG = 60_000;
  const byValue = (a: ForgetLedgerMark, b: ForgetLedgerMark): number =>
    b.value - a.value || Date.parse(a.raisedAt) - Date.parse(b.raisedAt);

  // As Workers KV: every value raised kept with its time, a read showing those that landed `LAG`
  // ago, and the younger only once `shown`.
  const setUpLagging = async () => {
    const { checkpointStore } = await memory().createStorage();
    const { logger, entries } = createRecordingLogger("omit");
    const raised = new Map<string, { mark: ForgetLedgerMark; landed: number }[]>();
    const time = { now: 0, shown: false };
    const ledger: Pick<
      ForgetLedger,
      "readMark" | "raiseMark" | "pruneMarks" | "visibilityDelayMs"
    > = {
      visibilityDelayMs: LAG,
      readMark: async (name) =>
        (raised.get(name) ?? [])
          .filter(({ landed }) => time.shown || landed <= time.now - LAG)
          .map(({ mark }) => mark)
          .sort(byValue),
      raiseMark: async (name, mark) => {
        const kept = raised.get(name) ?? [];
        raised.set(name, kept);
        if (
          kept.some(
            (held) => held.mark.value === mark.value && held.mark.raisedAt === mark.raisedAt,
          )
        )
          return;
        kept.push({ mark, landed: time.now });
      },
      pruneMarks: async (name, before) => {
        const kept = raised.get(name) ?? [];
        const [highest] = kept
          .map(({ mark }) => mark)
          .filter(({ raisedAt }) => raisedAt < before)
          .sort(byValue);
        raised.set(
          name,
          kept.filter(({ mark }) => mark === highest || mark.raisedAt >= before),
        );
      },
    };
    const stream = { head: 0 };
    const watchOver = () =>
      createRestoreWatch({
        checkpoints: checkpointStore,
        events: { lastPosition: async () => stream.head, readAll: async () => [] },
        marks: ledger,
        clock: {
          now: () => at(time.now),
          // A wait passes at once, the time going on.
          after: (milliseconds: number, callback: () => void) => {
            time.now += milliseconds;
            queueMicrotask(callback);
            return () => undefined;
          },
        },
        logger,
      });
    // Raised by an instance before, `ago` milliseconds before now.
    const raisedBefore = (name: string, value: number, ago: number) => {
      const kept = raised.get(name) ?? [];
      raised.set(name, kept);
      kept.push({
        mark: { value, raisedAt: at(time.now - ago).toISOString() },
        landed: time.now - ago,
      });
    };
    const valuesOf = (name: string) => (raised.get(name) ?? []).map(({ mark }) => mark.value);
    const marksOf = (name: string) => (raised.get(name) ?? []).map(({ mark }) => mark);
    // A watch over the same ledger, some of its calls replaced, and the same database, some of its.
    const watchWith = (
      replaced: Partial<typeof ledger>,
      checkpoints: CheckpointStore = checkpointStore,
    ) =>
      createRestoreWatch({
        checkpoints,
        events: { lastPosition: async () => stream.head, readAll: async () => [] },
        marks: { ...ledger, ...replaced },
        clock: {
          now: () => at(time.now),
          // A wait passes at once, the time going on.
          after: (milliseconds: number, callback: () => void) => {
            time.now += milliseconds;
            queueMicrotask(callback);
            return () => undefined;
          },
        },
        logger,
      });
    // Each error said, with the error it names.
    const errors = () =>
      entries
        .filter(({ level }) => level === "error")
        .map(({ message, fields }) => `${message}: ${String(fields?.errorName)}`);
    return {
      checkpointStore,
      ledger,
      logger,
      entries,
      errors,
      stream,
      time,
      watchOver,
      watchWith,
      raisedBefore,
      valuesOf,
      marksOf,
    };
  };

  it("counts at start a copy behind a mark its reads show already", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 3, 2 * LAG);
    expect(await watchOver().start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(4);
    expect(await checkpointStore.get(RESTORE_COVERED)).toBe(at(time.now).getTime());
  });

  it("counts a copy behind a mark its reads show only later, once they show every mark raised before it started, though the generation moved past it", async () => {
    const { checkpointStore, stream, time, watchOver, raisedBefore, valuesOf } =
      await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 1, 1);
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    expect(valuesOf(RESTORE_MARK)).toEqual([1, 0]);
    for (let round = 1; round < 12; round += 1) {
      stream.head += 1;
      time.now += GENERATION_INTERVAL_MS;
      expect(await watch.check(at(time.now), { active: true })).toBeNull();
    }
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBeGreaterThan(1);
    time.now += GENERATION_INTERVAL_MS;
    expect(await watch.check(at(time.now), { active: true })).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    time.now += GENERATION_INTERVAL_MS;
    expect(await watch.check(at(time.now), { active: true })).toBeNull();
    time.now += LAG;
    expect(await watch.check(at(time.now), { active: true })).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("moves nothing until the ledger took the generation the start read, at the time it started", async () => {
    const { checkpointStore, ledger, stream, time, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 1, 1);
    let refusing = true;
    const raised: ForgetLedgerMark[] = [];
    const recording = createRecordingLogger("omit");
    const logged = recording.entries;
    const watch = createRestoreWatch({
      checkpoints: checkpointStore,
      events: { lastPosition: async () => stream.head, readAll: async () => [] },
      marks: {
        ...ledger,
        raiseMark: async (name, mark) => {
          if (refusing) throw new Error("down");
          if (name === RESTORE_MARK) raised.push(mark);
          await ledger.raiseMark(name, mark);
        },
      },
      clock: {
        now: () => at(time.now),
        // A wait passes at once, the time going on.
        after: (milliseconds: number, callback: () => void) => {
          time.now += milliseconds;
          queueMicrotask(callback);
          return () => undefined;
        },
      },
      logger: recording.logger,
    });
    const startedAt = at(time.now).toISOString();
    expect(await watch.start()).toBeNull();
    stream.head += 1;
    time.now += GENERATION_INTERVAL_MS;
    await watch.check(at(time.now), { active: true });
    await watch.flush();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(0);
    refusing = false;
    time.now += GENERATION_INTERVAL_MS;
    await watch.check(at(time.now), { active: true });
    expect(raised[0]).toEqual({ value: 0, raisedAt: startedAt });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    // At start, at the check and at the stop; then no more.
    expect(
      logged
        .filter(({ level }) => level === "error")
        .map(({ message, fields }) => `${message}: ${String(fields?.errorName)}`),
    ).toEqual(
      Array.from({ length: 3 }, () => "the forget ledger's mark could not be raised: Error"),
    );
  });

  it("counts, once judged, a value raised before a lower one, though the database stands past both", async () => {
    const { checkpointStore, ledger, time, watchOver } = await setUpLagging();
    time.now = 10 * LAG;
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    time.now += LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    // Another look raised what it read below what was raised before, and counted nothing.
    await ledger.raiseMark(RESTORE_MARK, { value: 3, raisedAt: at(time.now).toISOString() });
    await ledger.raiseMark(RESTORE_MARK, { value: 2, raisedAt: at(time.now + 1).toISOString() });
    await checkpointStore.set(RESTORE_GENERATION, 5);
    time.now += LAG + 1;
    expect(await watch.check(at(time.now))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await watch.check(at(time.now + 1))).toBeNull();
  });

  it("judges only once its reads can be read, and only from the delay on", async () => {
    const { checkpointStore, ledger, time, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 1, 1);
    let down = false;
    const watch = createRestoreWatch({
      checkpoints: checkpointStore,
      events: { lastPosition: async () => 0, readAll: async () => [] },
      marks: {
        ...ledger,
        readMark: (name) => (down ? Promise.reject(new Error("down")) : ledger.readMark(name)),
      },
      clock: {
        now: () => at(time.now),
        // A wait passes at once, the time going on.
        after: (milliseconds: number, callback: () => void) => {
          time.now += milliseconds;
          queueMicrotask(callback);
          return () => undefined;
        },
      },
      logger: createRecordingLogger("omit").logger,
    });
    expect(await watch.start()).toBeNull();
    time.now += LAG - 1;
    expect(await watch.check(at(time.now))).toBeNull();
    down = true;
    time.now += 1;
    expect(await watch.check(at(time.now))).toBeNull();
    down = false;
    expect(await watch.check(at(time.now))).toEqual({ first: true });
  });

  it("counts once a copy found at start when a higher mark raised before shows later, and moves past it", async () => {
    const { checkpointStore, time, watchOver, raisedBefore, valuesOf } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 1, 2 * LAG);
    raisedBefore(RESTORE_MARK, 5, 1);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    await watch.settled();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(2);
    time.now += LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(6);
    expect(Math.max(...valuesOf(RESTORE_MARK))).toBe(6);
    expect(await watch.check(at(time.now + 1))).toBeNull();
    // The next start counts nothing either, whatever its reads show.
    expect(await watchOver().start()).toBeNull();
  });

  it("counts nothing for a mark raised before a restore counted since its start, which tells it", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 3, 1);
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    time.now += 1;
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    await watch.settled();
    time.now += LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBeGreaterThan(3);
  });

  it("waits, for a declaration where handling the last restore left the database, until the reads show every mark raised before the start, and counts the restore they tell", async () => {
    for (const [hidden, answer, restores] of [
      [true, { first: true, counted: true }, 2],
      [false, { first: true, counted: false }, 1],
    ] as const) {
      const { checkpointStore, stream, time, watchOver, raisedBefore } = await setUpLagging();
      time.now = 10 * LAG;
      const first = watchOver();
      await first.start();
      await first.declare();
      stream.head = 1;
      await first.settled();
      // A restore counted since, of which the next start's reads show nothing yet.
      time.now += 1;
      if (hidden) raisedBefore(RESTORE_MARK, 9, 0);
      const next = watchOver();
      expect(await next.start()).toBeNull();
      const declaredAt = time.now;
      const declared = await next.declare();
      expect(declared).toMatchObject(answer);
      expect(declared.found === undefined).toBe(!hidden);
      expect(time.now).toBe(declaredAt + LAG);
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(restores);
      await next.settled();
      // Every mark judged, a declaration made again answers at once.
      expect(await next.declare()).toEqual({ first: true, counted: false });
      expect(time.now).toBe(declaredAt + LAG);
    }
  });

  it("rejects a declaration that waited when the ledger's marks cannot be read then, counting nothing", async () => {
    const { checkpointStore, stream, time, watchOver, watchWith } = await setUpLagging();
    time.now = 10 * LAG;
    const first = watchOver();
    await first.start();
    await first.declare();
    stream.head = 1;
    await first.settled();
    const state = { down: false };
    const next = watchWith({
      readMark: async () => {
        if (state.down) throw new Error("down");
        return [];
      },
    });
    await next.start();
    state.down = true;
    await expect(next.declare()).rejects.toThrow("down");
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("rejects a declaration that waited when its look could not judge the marks, though the mark reads, and asks no more", async () => {
    const { checkpointStore, ledger, stream, time, watchOver, watchWith } = await setUpLagging();
    time.now = 10 * LAG;
    const first = watchOver();
    await first.start();
    await first.declare();
    stream.head = 1;
    await first.settled();
    const state = { down: false };
    let reads = 0;
    const next = watchWith({
      readMark: async (name) => {
        reads += 1;
        if (state.down && name === RESTORE_COUNT_MARK) throw new Error("down");
        return ledger.readMark(name);
      },
    });
    await next.start();
    state.down = true;
    reads = 0;
    await expect(next.declare()).rejects.toThrow(
      "the database could not be compared with the forget ledger's marks",
    );
    expect(reads).toBeLessThan(10);
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("counts, once judged, a database holding fewer restores than a count raised since the latest restore it counted, but no recount's", async () => {
    for (const [recount, found, restores] of [
      // Past every count the ledger holds.
      [false, { first: true }, 8],
      [true, null, 1],
    ] as const) {
      const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
      time.now = 10 * LAG;
      await checkpointStore.set(RESTORES_FOUND, 1);
      await checkpointStore.set(RESTORE_COVERED, at(time.now - 3 * LAG).getTime());
      raisedBefore(RESTORE_COUNT_MARK, 3, 2 * LAG);
      if (recount) raisedBefore(RESTORE_RECOUNTED_MARK, 3, 2 * LAG);
      // Older than the database's latest count: told already.
      raisedBefore(RESTORE_COUNT_MARK, 7, 4 * LAG);
      expect(await watchOver().start()).toEqual(found);
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(restores);
    }
  });

  it("takes a count made in place below a count the ledger raised since as the restore it is", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_COUNT_MARK, 3, 2 * LAG);
    await restoredInPlace(checkpointStore, 2);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    await watch.settled();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
  });

  it("moves the count again to what the last recount moved it to, on a copy taken before it, counting no restore", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_COUNT_MARK, 1, 3 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 1, 2 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 2, LAG);
    raisedBefore(RESTORE_RECOUNTED_MARK, 2, LAG);
    await checkpointStore.set(RESTORES_FOUND, 1);
    await checkpointStore.set(RESTORE_COVERED, at(time.now - 2 * LAG).getTime());
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    time.now += LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("moves the count back to the last recount's, not to a count raised since by a line the database left", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_COUNT_MARK, 1, 4 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 1, 3 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 2, 2 * LAG);
    raisedBefore(RESTORE_RECOUNTED_MARK, 2, 2 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 5, 1.5 * LAG);
    await checkpointStore.set(RESTORES_FOUND, 1);
    await checkpointStore.set(RESTORE_COVERED, at(time.now - LAG).getTime());
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    time.now += LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("tells a recount from a count of the same value or time, both a restore its copy lacks", async () => {
    for (const [value, ago] of [
      [3, 1.5 * LAG],
      [5, 2 * LAG],
    ] as const) {
      const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
      time.now = 10 * LAG;
      await checkpointStore.set(RESTORES_FOUND, 1);
      await checkpointStore.set(RESTORE_COVERED, at(time.now - 3 * LAG).getTime());
      raisedBefore(RESTORE_COUNT_MARK, 3, 2 * LAG);
      raisedBefore(RESTORE_RECOUNTED_MARK, 3, 2 * LAG);
      raisedBefore(RESTORE_COUNT_MARK, value, ago);
      expect(await watchOver().start()).toEqual({ first: true });
    }
  });

  it("counts, before the judgment, a copy below a mark raised since the latest restore counted, beside one raised before it", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    await checkpointStore.set(RESTORES_FOUND, 1);
    await checkpointStore.set(RESTORE_GENERATION, 2);
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    time.now += 5;
    time.shown = true;
    await checkpointStore.set(RESTORE_COVERED, at(time.now - 3).getTime());
    raisedBefore(RESTORE_MARK, 5, 4);
    raisedBefore(RESTORE_MARK, 6, 1);
    expect(await watch.check(at(time.now))).toEqual({ first: true });
  });

  it("moves a copy taken before a recount to the count it read, counting nothing, and still counts one counted earlier or later", async () => {
    for (const [covered, found, restores] of [
      [100, null, 2],
      [50, { first: true }, 3],
      [200, { first: true }, 3],
    ] as const) {
      const { checkpointStore, time, watchOver } = await setUpLagging();
      time.now = 10 * LAG;
      await checkpointStore.set(RESTORES_FOUND, 2);
      await checkpointStore.set(RESTORE_COVERED, 100);
      const watch = watchOver();
      await watch.start();
      await checkpointStore.set(RESTORES_FOUND, 1);
      await checkpointStore.set(RESTORE_COVERED, covered);
      expect(await watch.check(at(time.now))).toEqual(found);
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(restores);
    }
  });

  it("tells the ledger a recount before it raises its count, and leaves the database where handling the last restore left it", async () => {
    for (const failing of [false, true]) {
      const {
        checkpointStore,
        ledger,
        stream,
        time,
        watchOver,
        watchWith,
        raisedBefore,
        valuesOf,
      } = await setUpLagging();
      time.now = 10 * LAG;
      raisedBefore(RESTORE_COUNT_MARK, 1, 1);
      const first = watchOver();
      await first.start();
      time.now += LAG / 2;
      await first.declare();
      stream.head = 1;
      await first.settled();
      const handled = await checkpointStore.get(RESTORE_HANDLED);
      const next = watchWith({
        raiseMark: async (name, mark) => {
          if (failing && name === RESTORE_RECOUNTED_MARK) throw new Error("down");
          await ledger.raiseMark(name, mark);
        },
      });
      await next.start();
      time.now += LAG;
      expect(await next.check(at(time.now))).toBeNull();
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
      expect(await checkpointStore.get(RESTORE_HANDLED)).not.toBe(handled);
      expect(await next.declare()).toEqual({ first: true, counted: false });
      expect(valuesOf(RESTORE_RECOUNTED_MARK)).toEqual(failing ? [] : [2]);
      expect(valuesOf(RESTORE_COUNT_MARK)).toEqual(failing ? [1, 1] : [1, 1, 2]);
    }
  });

  it("counts past a count of the same value raised a moment before, which its reads did not show", async () => {
    const { checkpointStore, time, watchOver, raisedBefore, valuesOf } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_COUNT_MARK, 1, 1);
    const watch = watchOver();
    expect(await watch.start()).toBeNull();
    // Declared late enough that the judgment's reads do not show it yet.
    time.now += LAG / 2;
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    await watch.settled();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    time.now += LAG / 2;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
    expect(valuesOf(RESTORE_COUNT_MARK)).toEqual([1, 1, 2]);
    expect(valuesOf(RESTORE_RECOUNTED_MARK)).toEqual([2]);
    // Judged again, as the next start does, it counts those twice no more.
    const next = watchOver();
    expect(await next.start()).toBeNull();
    time.now += LAG;
    expect(await next.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
    // The next restore counts past both.
    await checkpointStore.set(RESTORE_GENERATION, 0);
    time.now += 1;
    expect(await watch.check(at(time.now))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(3);
  });

  it("counts at start past the count the database holds, when its reads show no count", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    await checkpointStore.set(RESTORES_FOUND, 2);
    raisedBefore(RESTORE_MARK, 3, 2 * LAG);
    expect(await watchOver().start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(3);
  });

  it("takes a mark raised at the time of the latest restore counted as raised since it, and one before as told already", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    await checkpointStore.set(RESTORE_COVERED, at(time.now - 2 * LAG).getTime());
    raisedBefore(RESTORE_MARK, 9, 2 * LAG + 1);
    expect(await watchOver().start()).toBeNull();
    raisedBefore(RESTORE_MARK, 3, 2 * LAG);
    expect(await watchOver().start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(4);
  });

  it("keeps the time of a restore counted on a ledger that reads what was written too", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await raiseTo(ledger, RESTORE_MARK, 4);
    expect(await watch.check(at(0))).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORE_COVERED)).toBe(at(0).getTime());
  });

  it("judges a ledger that lets nothing go, and says when one cannot", async () => {
    const { checkpointStore, ledger, logger, time, watchWith, errors } = await setUpLagging();
    time.now = 10 * LAG;
    const { pruneMarks: _, ...keepingAll } = ledger;
    const keeping = createRestoreWatch({
      checkpoints: checkpointStore,
      events: { lastPosition: async () => 0, readAll: async () => [] },
      marks: keepingAll,
      clock: {
        now: () => at(time.now),
        // A wait passes at once, the time going on.
        after: (milliseconds: number, callback: () => void) => {
          time.now += milliseconds;
          queueMicrotask(callback);
          return () => undefined;
        },
      },
      logger,
    });
    await keeping.start();
    time.now += LAG;
    expect(await keeping.check(at(time.now))).toBeNull();
    expect(errors()).toEqual([]);
    const failing = watchWith({ pruneMarks: () => Promise.reject(new Error("down")) });
    await failing.start();
    expect(errors()).toEqual(["the forget ledger's marks could not be pruned: Error"]);
    time.now += LAG;
    expect(await failing.check(at(time.now))).toBeNull();
    expect(errors()).toEqual([
      "the forget ledger's marks could not be pruned: Error",
      "the forget ledger's marks could not be pruned: Error",
    ]);
  });

  it("raises again, at the time first asked, a generation and a count the ledger did not take", async () => {
    const { checkpointStore, ledger, time, watchWith, marksOf, errors } = await setUpLagging();
    time.now = 10 * LAG;
    let refusing = false;
    const watch = watchWith({
      raiseMark: async (name, mark) => {
        if (refusing) throw new Error("down");
        await ledger.raiseMark(name, mark);
      },
    });
    await watch.start();
    time.now += LAG;
    await watch.check(at(time.now));
    refusing = true;
    await checkpointStore.set(RESTORE_GENERATION, 0);
    await checkpointStore.set(RESTORES_FOUND, 0);
    await ledger.raiseMark(RESTORE_MARK, { value: 5, raisedAt: at(time.now).toISOString() });
    time.now += LAG + 1;
    const countedAt = at(time.now).toISOString();
    expect(await watch.check(at(time.now))).toEqual({ first: true });
    expect(errors()).toContain("the forget ledger's count of restores could not be raised: Error");
    refusing = false;
    time.now += 1;
    await watch.check(at(time.now));
    expect(marksOf(RESTORE_COUNT_MARK)).toContainEqual({ value: 1, raisedAt: countedAt });
    expect(marksOf(RESTORE_MARK)).toContainEqual({ value: 6, raisedAt: countedAt });
  });

  it("raises no count another instance counted first", async () => {
    const { checkpointStore, time, watchWith, raisedBefore, valuesOf } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 3, 2 * LAG);
    const racing: CheckpointStore = {
      ...checkpointStore,
      compareAndSet: async (name, expected, position) => {
        if (name === RESTORES_FOUND) {
          await checkpointStore.set(RESTORES_FOUND, 7);
          return false;
        }
        return checkpointStore.compareAndSet(name, expected, position);
      },
    };
    expect(await watchWith({}, racing).start()).toEqual({ first: false });
    expect(valuesOf(RESTORE_COUNT_MARK)).toEqual([]);
  });

  it("finds at the judgment a restore another instance counted, which the marks do not tell", async () => {
    const { checkpointStore, time, watchOver } = await setUpLagging();
    time.now = 10 * LAG;
    const watch = watchOver();
    await watch.start();
    await checkpointStore.set(RESTORES_FOUND, 1);
    time.now += LAG;
    expect(await watch.check(at(time.now))).toEqual({ first: false });
  });

  it("lets go, once judged, of the counts raised more than a read may lag before the one it raises", async () => {
    const { checkpointStore, time, watchOver, raisedBefore, valuesOf } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_COUNT_MARK, 1, 3 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 2, 2 * LAG);
    const watch = watchOver();
    await checkpointStore.set(RESTORES_FOUND, 2);
    await watch.start();
    time.now += LAG;
    await watch.check(at(time.now));
    for (const counted of [3, 4]) {
      time.now += 2 * LAG;
      await checkpointStore.set(RESTORE_GENERATION, 0);
      // A copy that holds one restore fewer than counted.
      await checkpointStore.set(RESTORES_FOUND, counted - 2);
      expect(await watch.check(at(time.now))).toEqual({ first: true });
    }
    expect(valuesOf(RESTORE_COUNT_MARK)).toEqual([3, 4]);
  });

  it("counts again nothing it raised itself and its reads show, nor a count the last recount told", async () => {
    const { checkpointStore, ledger, time, watchOver, watchWith, raisedBefore } =
      await setUpLagging();
    time.now = 10 * LAG;
    const watch = watchOver();
    await watch.start();
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    await watch.settled();
    // Its own count shows by the judgment.
    time.now += 2 * LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    // Listed latest first within a value, the counts of one value before and after a recount,
    // raised after its own.
    raisedBefore(RESTORE_COUNT_MARK, 5, 1.75 * LAG);
    raisedBefore(RESTORE_RECOUNTED_MARK, 5, 1.5 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 5, 1.25 * LAG);
    await checkpointStore.set(RESTORES_FOUND, 5);
    const reversed = watchWith({
      readMark: async (name) => [...(await ledger.readMark(name))].reverse(),
    });
    await reversed.start();
    time.now += LAG;
    expect(await reversed.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(6);
  });

  it("counts past every count of its own its reads did not show at the judgment", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_COUNT_MARK, 2, 1);
    const watch = watchOver();
    await watch.start();
    time.now += LAG / 4;
    expect(await watch.declare()).toEqual({ first: true, counted: true });
    await watch.settled();
    time.now += LAG / 4;
    expect(await watch.declare({ again: true })).toEqual({ first: true, counted: true });
    await watch.settled();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
    time.now += LAG / 2;
    expect(await watch.check(at(time.now))).toBeNull();
    // Two counted before, which its own took the numbers of: four.
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
  });

  it("lets go of no count before the judgment, which counts each value counted twice", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_COUNT_MARK, 1, 3 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 1, 2 * LAG);
    await checkpointStore.set(RESTORES_FOUND, 1);
    const watch = watchOver();
    await watch.start();
    time.now += 1;
    await checkpointStore.set(RESTORES_FOUND, 0);
    expect(await watch.check(at(time.now))).toEqual({ first: true });
    time.now += LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(3);
  });

  it("raises a declaration's count at the time it was counted when the next start finishes it", async () => {
    const { checkpointStore, time, watchOver, valuesOf } = await setUpLagging();
    time.now = 10 * LAG;
    const declaring = watchOver();
    await declaring.start();
    time.now += 1;
    expect(await declaring.declare()).toEqual({ first: true, counted: true });
    // Gone before it settled: the next start finishes the declaration.
    time.now += 1;
    const next = watchOver();
    expect(await next.start()).toEqual({ first: true });
    await next.settled();
    expect(await checkpointStore.get(RESTORE_DECLARING_AT)).toBe(0);
    time.now += LAG;
    expect(await next.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    expect(valuesOf(RESTORE_COUNT_MARK)).toEqual([1]);
  });

  it("raises at the time it finishes a declaration left pending with no time of its own", async () => {
    const { checkpointStore, time, watchOver, marksOf } = await setUpLagging();
    time.now = 10 * LAG;
    await checkpointStore.set(RESTORE_DECLARING, 1);
    expect(await watchOver().start()).toEqual({ first: true });
    expect(marksOf(RESTORE_COUNT_MARK)).toEqual([
      { value: 1, raisedAt: at(time.now).toISOString() },
    ]);
  });

  it("takes a value counted again at the very time of the last recount as that recount's", async () => {
    const { checkpointStore, time, watchOver, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_COUNT_MARK, 8, 2 * LAG + 1);
    raisedBefore(RESTORE_RECOUNTED_MARK, 8, 2 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 8, 2 * LAG);
    await checkpointStore.set(RESTORES_FOUND, 8);
    const watch = watchOver();
    await watch.start();
    time.now += LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(8);
  });

  it("raises again, as counted, a count the ledger took only later, and counts it once", async () => {
    const { checkpointStore, ledger, time, watchWith, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 3, 2 * LAG);
    let refusing = true;
    const watch = watchWith({
      raiseMark: async (name, mark) => {
        if (refusing && name === RESTORE_COUNT_MARK) throw new Error("down");
        await ledger.raiseMark(name, mark);
      },
    });
    expect(await watch.start()).toEqual({ first: true });
    await watch.settled();
    refusing = false;
    time.now += LAG / 2;
    await watch.check(at(time.now));
    time.now += LAG / 2;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("moves nothing as it settles a restore before the ledger took the generation the start read", async () => {
    const { checkpointStore, ledger, stream, time, watchWith, raisedBefore } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 3, 2 * LAG);
    const watch = watchWith({
      raiseMark: async (name, mark) => {
        if (name === RESTORE_MARK && mark.value === 0) throw new Error("down");
        await ledger.raiseMark(name, mark);
      },
    });
    expect(await watch.start()).toEqual({ first: true });
    stream.head += 1;
    await watch.settled();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(4);
  });

  it("raises again, at the time first asked, a generation raised once more meanwhile", async () => {
    const { checkpointStore, ledger, stream, time, watchWith, marksOf } = await setUpLagging();
    time.now = 10 * LAG;
    let refusing = false;
    const watch = watchWith({
      raiseMark: async (name, mark) => {
        if (refusing) throw new Error("down");
        await ledger.raiseMark(name, mark);
      },
    });
    await watch.start();
    time.now += LAG;
    await watch.check(at(time.now));
    refusing = true;
    stream.head += 1;
    time.now += GENERATION_INTERVAL_MS;
    const movedAt = at(time.now).toISOString();
    await watch.check(at(time.now), { active: true });
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(1);
    time.now += 1;
    // The stop raises it once more, and the ledger refuses it again.
    await watch.flush();
    refusing = false;
    time.now += 1;
    await watch.check(at(time.now));
    expect(marksOf(RESTORE_MARK)).toContainEqual({ value: 1, raisedAt: movedAt });
  });

  it("says when the ledger did not take a recount", async () => {
    const { checkpointStore, ledger, time, watchWith, raisedBefore, errors } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_COUNT_MARK, 1, 3 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 1, 2 * LAG);
    await checkpointStore.set(RESTORES_FOUND, 1);
    const watch = watchWith({
      raiseMark: async (name, mark) => {
        if (name === RESTORE_RECOUNTED_MARK) throw new Error("down");
        await ledger.raiseMark(name, mark);
      },
    });
    await watch.start();
    time.now += LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
    expect(errors()).toEqual([
      "the forget ledger's recount of restores could not be raised: Error",
    ]);
  });

  it("tells, from the start that finds a restore counted in place, every mark raised and entry written before as that restore's", async () => {
    const { checkpointStore, time, watchOver } = await setUpLagging();
    time.now = 10 * LAG;
    await restoredInPlace(checkpointStore, 1);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORE_COVERED)).toBe(at(time.now).getTime());
    time.now += 1;
    await watch.settled();
    expect(await checkpointStore.get(RESTORE_COVERED)).toBe(at(time.now).getTime());
  });

  it("lets go at start of the values raised a delay before only once the ledger took its reading, and of none it could not compare", async () => {
    const { checkpointStore, ledger, time, watchWith, raisedBefore, valuesOf } =
      await setUpLagging();
    time.now = 10 * LAG;
    await checkpointStore.set(RESTORE_GENERATION, 1);
    raisedBefore(RESTORE_MARK, 0, 3 * LAG);
    raisedBefore(RESTORE_MARK, 1, 2 * LAG);
    let refusing = true;
    const refused = watchWith({
      raiseMark: async (name, mark) => {
        if (refusing) throw new Error("down");
        return ledger.raiseMark(name, mark);
      },
    });
    expect(await refused.start()).toBeNull();
    expect(valuesOf(RESTORE_MARK)).toEqual([0, 1]);
    refusing = false;
    time.now += GENERATION_INTERVAL_MS;
    expect(await refused.check(at(time.now))).toBeNull();
    // Taken at last, the reading holds at least every value raised a delay before the start.
    expect(valuesOf(RESTORE_MARK)).toEqual([1, 1]);
  });

  it("lets go of nothing at start when it could not read the marks, though the ledger took its reading after", async () => {
    const { checkpointStore, ledger, time, watchWith, raisedBefore, valuesOf } =
      await setUpLagging();
    time.now = 10 * LAG;
    await checkpointStore.set(RESTORE_GENERATION, 1);
    raisedBefore(RESTORE_MARK, 0, 3 * LAG);
    raisedBefore(RESTORE_MARK, 1, 2 * LAG);
    let unreadable = true;
    const pruned: string[] = [];
    const blind = watchWith({
      readMark: async (name) => {
        if (unreadable) throw new Error("down");
        return ledger.readMark(name);
      },
      pruneMarks: async (name, before) => {
        pruned.push(name);
        return ledger.pruneMarks?.(name, before);
      },
    });
    expect(await blind.start()).toBeNull();
    unreadable = false;
    time.now += GENERATION_INTERVAL_MS;
    await blind.check(at(time.now));
    expect(valuesOf(RESTORE_MARK)).toEqual([0, 1, 1]);
    expect(pruned).toEqual([]);
  });

  it("lets go at start of the values raised a delay before, once judged of those raised before it started, and then once a delay of those older, but the highest", async () => {
    const { stream, time, watchOver, raisedBefore, valuesOf } = await setUpLagging();
    time.now = 10 * LAG;
    raisedBefore(RESTORE_MARK, 2, 3 * LAG);
    raisedBefore(RESTORE_MARK, 1, 2 * LAG);
    raisedBefore(RESTORE_COUNT_MARK, 1, 2 * LAG);
    raisedBefore(RESTORE_MARK, 0, LAG / 2);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    // Of the values raised a delay before it started, which its reads showed, the highest stays.
    expect(valuesOf(RESTORE_MARK)).toEqual([2, 0, 3, 0]);
    time.now += LAG;
    expect(await watch.check(at(time.now))).toBeNull();
    // Of the values raised before it started, the highest stays.
    expect(valuesOf(RESTORE_MARK)).toEqual([2, 3, 0]);
    expect(valuesOf(RESTORE_COUNT_MARK)).toEqual([1, 2]);
    stream.head += 1;
    time.now += GENERATION_INTERVAL_MS;
    await watch.check(at(time.now), { active: true });
    // Within a delay of the last prune, a raise lets nothing go: it costs one write.
    expect(valuesOf(RESTORE_MARK)).toEqual([2, 3, 0, 4]);
    stream.head += 1;
    // A delay after the judgment's prune, to the millisecond.
    time.now += LAG - GENERATION_INTERVAL_MS;
    await watch.check(at(time.now), { active: true });
    // Of those older than a read may lag, the highest stays.
    expect(valuesOf(RESTORE_MARK)).toEqual([3, 4, 5]);
  });
});
