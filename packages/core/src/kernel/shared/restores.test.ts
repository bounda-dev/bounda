import { describe, expect, it } from "vitest";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import { fenceError } from "../../adapter/storage/tenant-fence.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import { DEFAULT_TENANT } from "../personal-data/tenant-keys.ts";
import { createRecordingLogger } from "../test-support.ts";
import {
  createRestoreWatch,
  GENERATION_INTERVAL_MS,
  RESTORE_DECLARING,
  RESTORE_GENERATION,
  RESTORE_HANDLED,
  RESTORE_HANDLED_AT,
  RESTORE_MARK,
  RESTORE_UNCLAIMED,
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
  const ledger = await memory().createForgetLedger({ tenant: DEFAULT_TENANT });
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
    await ledger.raiseMark(RESTORE_MARK, 20);
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
      expect(await watchOver().declare()).toEqual({ first: true });
      expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    },
  );

  it("moves the generation past the mark, which it raises to the same", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await ledger.raiseMark(RESTORE_MARK, 9);
    await checkpointStore.set(RESTORE_GENERATION, 4);
    await watchOver().declare();
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(10);
    expect(await ledger.readMark(RESTORE_MARK)).toBe(10);
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
    expect(await again.declare()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    // Taken once handled, and declaring it again counts nothing more.
    expect(await checkpointStore.get(RESTORE_DECLARING)).toBe(1);
    await again.settled();
    expect(await checkpointStore.get(RESTORE_DECLARING)).toBe(0);
    expect(await watchOver().declare()).toEqual({ first: true });
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
      await ledger.raiseMark(RESTORE_MARK, 1);
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
    expect(declared).toEqual([{ first: true }, { first: true }]);
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
  });

  it("declares again the restore it counted and has not settled, counting it once", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    await ledger.raiseMark(RESTORE_MARK, 5);
    const watch = watchOver();
    expect(await watch.start()).toEqual({ first: true });
    expect(await watch.declare()).toEqual({ first: true });
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
    expect(await checkpointStore.get(RESTORE_HANDLED_AT)).toBe(2);
    const next = watchOver();
    await next.start();
    expect(await next.declare()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    // The same database once the generation moved, the mark with it: still where it was left.
    await next.check(at(0), { active: true });
    expect(await next.declare()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    // A copy of it taken before that move stands behind the mark.
    expect(await ledger.readMark(RESTORE_MARK)).toBeGreaterThan(1);
    await checkpointStore.set(RESTORE_GENERATION, 1);
    expect(await watchOver().declare()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("counts an operator's declaration of a database that moved on from where the last restore handled left it", async () => {
    const { checkpointStore, stream, watchOver } = await setUp();
    const first = watchOver();
    await first.start();
    await first.declare();
    await first.settled();
    stream.head = 4;
    expect(await watchOver().declare()).toEqual({ first: true });
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
    expect(await next.declare()).toEqual({ first: true });
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
    expect(await next.declare({ reconciled: true })).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("counts a restore the ledger tells to an instance that has read nothing yet", async () => {
    const { checkpointStore, watchOver } = await setUp();
    await checkpointStore.set(RESTORES_FOUND, 1);
    expect(await watchOver().declare({ reconciled: true })).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("joins, for a restore the ledger tells, the one another instance counted since this one read", async () => {
    const { checkpointStore, watchOver } = await setUp();
    const watch = watchOver();
    await watch.start();
    await checkpointStore.set(RESTORES_FOUND, 1);
    expect(await watch.declare({ reconciled: true })).toEqual({ first: false });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(1);
    // Read since: a later one counts.
    expect(await watch.declare({ reconciled: true })).toEqual({ first: true });
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
    expect(await watchOver().declare()).toEqual({ first: true });
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
    expect(await ledger.readMark(RESTORE_MARK)).toBe(2);
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
    expect(await watch.declare()).toEqual({ first: true });
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
        raiseMark: (name, value) => inner.raiseMark(name, value),
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
    await ledger.raiseMark(RESTORE_MARK, 5);
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
    expect(await watch.declare()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(2);
  });

  it("counts a copy taken while a declaration was under way as another restore, past it, and clears its row once handled", async () => {
    const { checkpointStore, ledger, watchOver } = await setUp();
    // The live database moved past the declaration the copy holds, and the mark with it.
    await ledger.raiseMark(RESTORE_MARK, 4);
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
    await ledger.raiseMark(RESTORE_MARK, 4);
    await checkpointStore.set(RESTORE_GENERATION, 2);
    await checkpointStore.set(RESTORE_DECLARING, 3);
    await checkpointStore.set(RESTORES_FOUND, 2);
    expect(await watch.declare()).toEqual({ first: true });
    expect(await checkpointStore.get(RESTORES_FOUND)).toBe(4);
    expect(await checkpointStore.get(RESTORE_GENERATION)).toBe(5);
  });

  it("leaves the generation where another instance moved it past the declaration's", async () => {
    let moving: () => Promise<void> = async () => undefined;
    const { checkpointStore, watchOver } = await setUp({
      ledger: (inner) => ({
        readMark: (name) => inner.readMark(name),
        raiseMark: async (name, value) => {
          await inner.raiseMark(name, value);
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
