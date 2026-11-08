import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ReadForgetLedgerArgs,
} from "../../adapter/storage/forget-ledger.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { HOLD_MS } from "./hold.ts";
import {
  createForgetLedgerReconciliation,
  FORGET_LEDGER_ATTEMPTS,
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_HELD_UNTIL,
  FORGET_LEDGER_LAST_RUN,
  FORGET_LEDGER_REREAD_MS,
  type ForgetAgainEntry,
  forgetAgain,
} from "./reconciliation.ts";

const NOW = new Date("2026-03-01T00:00:00.000Z");
const EVERY = 5 * 60_000;

const keyed = async (storage: Storage, persons: readonly string[]): Promise<void> => {
  for (const person of persons) {
    await storage.transact((transaction) =>
      transaction.personalKeys.add(person, {
        key: `key-${person}`,
        fingerprint: `f-${person}`,
        kid: null,
      }),
    );
  }
};

const recordingLedger = (entries: readonly ForgetLedgerEntry[], visibilityDelayMs?: number) => {
  const reads: ReadForgetLedgerArgs[] = [];
  const inner = memory();
  const ledger: ForgetLedger = {
    ...(visibilityDelayMs === undefined ? {} : { visibilityDelayMs }),
    append: async () => {},
    read: async (args) => {
      reads.push(args);
      const opened = await inner.createForgetLedger({});
      await opened.append(entries);
      return opened.read(args);
    },
  };
  return { ledger, reads };
};

const setUp = async ({
  entries,
  persons = [],
  pageSize = 2,
  visibilityDelayMs,
  logger = silentLogger,
}: {
  readonly entries: readonly ForgetLedgerEntry[];
  readonly persons?: readonly string[];
  readonly pageSize?: number;
  readonly visibilityDelayMs?: number;
  readonly logger?: Logger;
}) => {
  const storage = await memory().createStorage();
  await keyed(storage, persons);
  const { ledger, reads } = recordingLedger(entries, visibilityDelayMs);
  const reconciliation = createForgetLedgerReconciliation({
    ledger,
    storage,
    ids: createSequentialIdGenerator(),
    clock: createFixedClock(NOW),
    logger,
    concurrencyRetries: 3,
    reconcileEveryMs: EVERY,
    keepForMs: null,
    pageSize,
  });
  return { storage, reconciliation, reads };
};

const entry = (personId: string, eventId: string, forgottenAt: string): ForgetLedgerEntry => ({
  personId,
  eventId,
  forgottenAt,
});

const at = (minute: number): string => new Date(NOW.getTime() + minute * 60_000).toISOString();

describe("the forget ledger's reconciliation", () => {
  it("reads every page of the ledger, and stops at the first short one", async () => {
    const persons = ["c-1", "c-2", "c-3", "c-4", "c-5"];
    const { reconciliation, reads, storage } = await setUp({
      entries: persons.map((person, index) => entry(person, `e-${index}`, at(index))),
      persons,
    });
    expect(await reconciliation.reconcile(NOW)).toBe(5);
    expect(reads).toHaveLength(3);
    expect(reads[0]).toStrictEqual({ limit: 2 });
    expect(reads[1]).toEqual({ after: entry("c-2", "e-1", at(1)), limit: 2 });
    expect(await storage.checkpointStore.get(FORGET_LEDGER_CURSOR)).toBe(Date.parse(at(4)));
  });

  it("reads a full last page once more, and finds it empty", async () => {
    const { reconciliation, reads } = await setUp({
      entries: [entry("c-1", "e-1", at(1)), entry("c-2", "e-2", at(2))],
    });
    expect(await reconciliation.reconcile(NOW)).toBe(0);
    expect(reads).toHaveLength(2);
  });

  it("reads from the first entry while the cursor was never moved, however old the entry", async () => {
    const { reconciliation } = await setUp({
      entries: [entry("c-1", "e-1", "1969-07-20T20:17:00.000Z")],
      persons: ["c-1"],
    });
    expect(await reconciliation.reconcile(NOW)).toBe(1);
  });

  it("reads from the very start of the window before the cursor", async () => {
    const { reconciliation, storage } = await setUp({
      entries: [entry("c-1", "A-first", at(0))],
      persons: ["c-1"],
    });
    await storage.checkpointStore.set(
      FORGET_LEDGER_CURSOR,
      NOW.getTime() + FORGET_LEDGER_REREAD_MS,
    );
    expect(await reconciliation.reconcile(NOW)).toBe(1);
  });

  it("leaves the cursor where it was for an entry whose time it cannot read", async () => {
    const { reconciliation, storage } = await setUp({
      entries: [entry("c-1", "e-1", "not a time")],
    });
    expect(await reconciliation.reconcile(NOW)).toBe(0);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_CURSOR)).toBe(0);
  });

  it("never moves the cursor back", async () => {
    const { reconciliation, storage } = await setUp({ entries: [entry("c-1", "e-1", at(1))] });
    const later = Date.parse(at(1)) + FORGET_LEDGER_REREAD_MS - 1;
    await storage.checkpointStore.set(FORGET_LEDGER_CURSOR, later);
    await reconciliation.reconcile(NOW);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_CURSOR)).toBe(later);
  });

  it("is not reconciled before its first reconciliation, nor due again until the period ends", async () => {
    const { reconciliation, reads } = await setUp({ entries: [] });
    expect(reconciliation.reconciled()).toBe(false);
    expect(reconciliation.nextDueAt()).toBeNull();
    expect(await reconciliation.sweep(NOW)).toBe(0);
    expect(reads).toEqual([]);
    await reconciliation.reconcile(NOW);
    expect(reconciliation.reconciled()).toBe(true);
    expect(reconciliation.nextDueAt()).toBeNull();
    expect(await reconciliation.sweep(new Date(NOW.getTime() + EVERY - 1))).toBe(0);
    expect(reads).toHaveLength(1);
    expect(await reconciliation.sweep(new Date(NOW.getTime() + EVERY))).toBe(0);
    expect(reads).toHaveLength(2);
    expect(reconciliation.nextDueAt()).toBeNull();
  });

  it("reads a ledger without delay once, and one with a delay once more after it", async () => {
    const none = await setUp({ entries: [], visibilityDelayMs: 0 });
    await none.reconciliation.reconcile(NOW);
    expect(none.reconciliation.nextDueAt()).toBeNull();

    const late = await setUp({
      entries: [entry("c-1", "e-1", at(0))],
      persons: ["c-1"],
      visibilityDelayMs: 1,
    });
    await late.reconciliation.reconcile(NOW);
    expect(late.reconciliation.nextDueAt()).toEqual(new Date(NOW.getTime() + 1));
    expect(await late.reconciliation.sweep(NOW)).toBe(0);
    expect(await late.reconciliation.sweep(new Date(NOW.getTime() + 1))).toBe(0);
    expect(late.reconciliation.nextDueAt()).toBeNull();
  });

  it("says in a sweep how many persons it forgot", async () => {
    let failures = 1;
    const storage = await memory().createStorage();
    await keyed(storage, ["c-1"]);
    const inner = await memory().createForgetLedger({});
    await inner.append([entry("c-1", "e-1", at(0))]);
    const reconciliation = createForgetLedgerReconciliation({
      ledger: {
        append: async () => {},
        read: async (args) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("down");
          }
          return inner.read(args);
        },
      },
      storage,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger: silentLogger,
      concurrencyRetries: 3,
      reconcileEveryMs: EVERY,
      keepForMs: null,
      pageSize: 10,
    });
    expect(await reconciliation.reconcile(NOW)).toEqual({ failed: new Error("down") });
    const due = reconciliation.nextDueAt() as Date;
    expect(await reconciliation.sweep(due)).toBe(1);
  });

  it("keeps its own hold when the store cannot keep it, and logs it", async () => {
    const storage = await memory().createStorage();
    const holdRows = new Set([FORGET_LEDGER_HELD_UNTIL, FORGET_LEDGER_ATTEMPTS]);
    const refuse = (name: string): void => {
      if (holdRows.has(name)) throw new Error("read-only");
    };
    const checkpoints: CheckpointStore = {
      ...storage.checkpointStore,
      get: async (name) => {
        refuse(name);
        return storage.checkpointStore.get(name);
      },
      set: async (name, value) => {
        refuse(name);
        return storage.checkpointStore.set(name, value);
      },
    };
    const errors: unknown[] = [];
    let reads = 0;
    const reconciliation = createForgetLedgerReconciliation({
      ledger: {
        append: async () => {},
        read: async () => {
          reads += 1;
          throw new Error("down");
        },
      },
      storage: { ...storage, checkpointStore: checkpoints },
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger: { ...silentLogger, error: (message) => errors.push(message) },
      concurrencyRetries: 3,
      reconcileEveryMs: EVERY,
      keepForMs: null,
    });
    expect(await reconciliation.reconcile(NOW)).toEqual({ failed: new Error("down") });
    expect(errors).toEqual([
      "forget ledger could not be reconciled; persons a restored backup brought back are not forgotten yet",
      "forget ledger's reconciliation could not be held",
    ]);
    expect(reconciliation.nextDueAt()).toEqual(new Date(NOW.getTime() + HOLD_MS));
    expect(await reconciliation.sweep(new Date(NOW.getTime() + HOLD_MS - 1))).toBe(0);
    expect(reads).toBe(1);
    const due = new Date(NOW.getTime() + HOLD_MS);
    expect(await reconciliation.sweep(due)).toBe(0);
    expect(reads).toBe(2);
    expect(reconciliation.nextDueAt()).toEqual(new Date(due.getTime() + 2 * HOLD_MS));
  });

  it("writes no hold when it succeeds with none, and clears one another instance left", async () => {
    const storage = await memory().createStorage();
    const written: string[] = [];
    let removable = true;
    const checkpoints: CheckpointStore = {
      ...storage.checkpointStore,
      set: async (name, value) => {
        written.push(`set ${name}`);
        return storage.checkpointStore.set(name, value);
      },
      remove: async (name) => {
        written.push(`remove ${name}`);
        if (!removable) throw new Error("read-only");
        return storage.checkpointStore.remove(name);
      },
    };
    const errors: unknown[] = [];
    const create = () =>
      createForgetLedgerReconciliation({
        ledger: recordingLedger([]).ledger,
        storage: { ...storage, checkpointStore: checkpoints },
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
        logger: { ...silentLogger, error: (message) => errors.push(message) },
        concurrencyRetries: 3,
        reconcileEveryMs: EVERY,
        keepForMs: null,
      });
    expect(await create().reconcile(NOW)).toBe(0);
    expect(written).toEqual([]);
    await storage.checkpointStore.set(FORGET_LEDGER_ATTEMPTS, 3);
    await storage.checkpointStore.set(FORGET_LEDGER_HELD_UNTIL, NOW.getTime() + HOLD_MS);
    removable = false;
    expect(await create().reconcile(NOW)).toBe(0);
    expect(errors).toEqual(["forget ledger's reconciliation hold could not be cleared"]);
    removable = true;
    expect(await create().reconcile(NOW)).toBe(0);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_ATTEMPTS)).toBe(0);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_HELD_UNTIL)).toBe(0);
  });

  it("reads the hold on a pass a ledger's delay calls for once, after the cursor, only to clear it", async () => {
    const storage = await memory().createStorage();
    const asked: string[] = [];
    const reconciliation = createForgetLedgerReconciliation({
      ledger: recordingLedger([], 1).ledger,
      storage: {
        ...storage,
        checkpointStore: {
          ...storage.checkpointStore,
          get: async (name) => {
            asked.push(name);
            return storage.checkpointStore.get(name);
          },
        },
      },
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger: silentLogger,
      concurrencyRetries: 3,
      reconcileEveryMs: EVERY,
      keepForMs: null,
    });
    await reconciliation.reconcile(NOW);
    asked.length = 0;
    await reconciliation.sweep(new Date(NOW.getTime() + 1));
    expect(asked.filter((name) => name === FORGET_LEDGER_HELD_UNTIL)).toHaveLength(1);
    expect(asked.indexOf(FORGET_LEDGER_HELD_UNTIL)).toBeGreaterThan(
      asked.indexOf(FORGET_LEDGER_CURSOR),
    );
  });

  it("clears a hold left with its end alone, and tells whom it forgot again", async () => {
    const storage = await memory().createStorage();
    await keyed(storage, ["c-1"]);
    await storage.checkpointStore.set(FORGET_LEDGER_HELD_UNTIL, NOW.getTime() + 60_000);
    const told: string[] = [];
    const reconciliation = createForgetLedgerReconciliation({
      ledger: recordingLedger([entry("c-1", "e-1", at(0))]).ledger,
      storage,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger: silentLogger,
      concurrencyRetries: 3,
      reconcileEveryMs: EVERY,
      keepForMs: null,
      forgotten: (personId) => told.push(personId),
    });
    expect(await reconciliation.reconcile(NOW)).toBe(1);
    expect(told).toEqual(["c-1"]);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_HELD_UNTIL)).toBe(0);
    // Its attempts alone, too.
    await storage.checkpointStore.set(FORGET_LEDGER_ATTEMPTS, 3);
    expect(await reconciliation.reconcile(NOW)).toBe(0);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_ATTEMPTS)).toBe(0);
  });

  it("warns only when it forgot someone", async () => {
    const warnings: unknown[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    const { reconciliation } = await setUp({ entries: [entry("c-1", "e-1", at(0))], logger });
    await reconciliation.reconcile(NOW);
    expect(warnings).toEqual([]);
  });
});

describe("the forget ledger's periodic reconciliation", () => {
  const periodic = async ({
    checkpoints = (store: CheckpointStore) => store,
    prune,
    keepForMs = null,
    logger = silentLogger,
    failures = 0,
  }: {
    readonly checkpoints?: (store: CheckpointStore) => CheckpointStore;
    readonly prune?: ForgetLedger["prune"];
    readonly keepForMs?: number | null;
    readonly logger?: Logger;
    readonly failures?: number;
  } = {}) => {
    const storage = await memory().createStorage();
    const { ledger, reads } = recordingLedger([]);
    let left = failures;
    const reconciliation = createForgetLedgerReconciliation({
      ledger: {
        ...ledger,
        read: async (args) => {
          if (left > 0) {
            left -= 1;
            reads.push(args);
            throw new Error("down");
          }
          return ledger.read(args);
        },
        ...(prune === undefined ? {} : { prune }),
      },
      storage: { ...storage, checkpointStore: checkpoints(storage.checkpointStore) },
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger,
      concurrencyRetries: 3,
      reconcileEveryMs: EVERY,
      keepForMs,
    });
    return { storage, reconciliation, reads };
  };

  const later = (milliseconds: number): Date => new Date(NOW.getTime() + milliseconds);

  it("keeps when it last reconciled, and leaves the period to whichever instance took it last", async () => {
    const { storage, reconciliation, reads } = await periodic();
    expect(await reconciliation.reconcile(NOW)).toBe(0);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_LAST_RUN)).toBe(NOW.getTime());
    // Another instance took the period since.
    await storage.checkpointStore.set(FORGET_LEDGER_LAST_RUN, NOW.getTime() + 1_000);
    expect(await reconciliation.sweep(later(EVERY))).toBe(0);
    expect(reads).toHaveLength(1);
    expect(await reconciliation.sweep(later(EVERY + 999))).toBe(0);
    expect(reads).toHaveLength(1);
    expect(await reconciliation.sweep(later(EVERY + 1_000))).toBe(0);
    expect(reads).toHaveLength(2);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_LAST_RUN)).toBe(
      NOW.getTime() + EVERY + 1_000,
    );
  });

  it("takes a period whose last run a clock ahead wrote more than a round from now", async () => {
    const { storage, reconciliation, reads } = await periodic();
    await reconciliation.reconcile(NOW);
    await storage.checkpointStore.set(FORGET_LEDGER_LAST_RUN, NOW.getTime() + 2 * EVERY + 1);
    expect(await reconciliation.sweep(later(EVERY))).toBe(0);
    expect(reads).toHaveLength(2);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_LAST_RUN)).toBe(NOW.getTime() + EVERY);
    await storage.checkpointStore.set(FORGET_LEDGER_LAST_RUN, NOW.getTime() + 3 * EVERY);
    expect(await reconciliation.sweep(later(2 * EVERY))).toBe(0);
    expect(reads).toHaveLength(2);
  });

  it("reconciles at once when a restore took the last run back", async () => {
    const { storage, reconciliation, reads } = await periodic();
    await reconciliation.reconcile(NOW);
    await storage.checkpointStore.set(FORGET_LEDGER_LAST_RUN, NOW.getTime() - EVERY);
    expect(await reconciliation.sweep(later(EVERY - 1))).toBe(0);
    expect(reads).toHaveLength(1);
    expect(await reconciliation.sweep(later(EVERY))).toBe(0);
    expect(reads).toHaveLength(2);
  });

  it("leaves the period to the instance that moved the row first", async () => {
    const { reconciliation, reads } = await periodic({
      checkpoints: (store) => ({
        ...store,
        compareAndSet: async (name, expected, position) =>
          name === FORGET_LEDGER_LAST_RUN && position === NOW.getTime() + EVERY
            ? false
            : store.compareAndSet(name, expected, position),
      }),
    });
    await reconciliation.reconcile(NOW);
    expect(await reconciliation.sweep(later(EVERY))).toBe(0);
    expect(reads).toHaveLength(1);
    expect(await reconciliation.sweep(later(2 * EVERY - 1))).toBe(0);
    expect(reads).toHaveLength(1);
    expect(await reconciliation.sweep(later(2 * EVERY))).toBe(0);
    expect(reads).toHaveLength(2);
  });

  it("reconciles when the store cannot say whether another instance did", async () => {
    let readable = true;
    const { reconciliation, reads } = await periodic({
      checkpoints: (store) => ({
        ...store,
        get: async (name) => {
          if (!readable && name === FORGET_LEDGER_LAST_RUN) throw new Error("read-only");
          return store.get(name);
        },
        compareAndSet: async (name, expected, position) => {
          if (!readable && name === FORGET_LEDGER_LAST_RUN) throw new Error("read-only");
          return store.compareAndSet(name, expected, position);
        },
      }),
    });
    await reconciliation.reconcile(NOW);
    readable = false;
    expect(await reconciliation.sweep(later(EVERY))).toBe(0);
    expect(reads).toHaveLength(2);
    readable = true;
    const writes = await periodic({
      checkpoints: (store) => ({
        ...store,
        compareAndSet: async (name, expected, position) => {
          if (name === FORGET_LEDGER_LAST_RUN && position === NOW.getTime() + EVERY) {
            throw new Error("read-only");
          }
          return store.compareAndSet(name, expected, position);
        },
      }),
    });
    await writes.reconciliation.reconcile(NOW);
    expect(await writes.reconciliation.sweep(later(EVERY))).toBe(0);
    expect(writes.reads).toHaveLength(2);
  });

  it("logs a last run it cannot keep, and stays reconciled", async () => {
    const errors: unknown[] = [];
    const { reconciliation } = await periodic({
      checkpoints: (store) => ({
        ...store,
        compareAndSet: async (name, expected, position) => {
          if (name === FORGET_LEDGER_LAST_RUN) throw new Error("read-only");
          return store.compareAndSet(name, expected, position);
        },
      }),
      logger: { ...silentLogger, error: (message) => errors.push(message) },
    });
    expect(await reconciliation.reconcile(NOW)).toBe(0);
    expect(errors).toEqual(["forget ledger's last reconciliation could not be kept"]);
    expect(reconciliation.reconciled()).toBe(true);
  });

  it("waits for a failure's hold, of any instance, before the period", async () => {
    const { storage, reconciliation, reads } = await periodic();
    await reconciliation.reconcile(NOW);
    await storage.checkpointStore.set(FORGET_LEDGER_HELD_UNTIL, NOW.getTime() + EVERY + 1_000);
    expect(await reconciliation.sweep(later(EVERY))).toBe(0);
    expect(reads).toHaveLength(1);
    expect(await reconciliation.sweep(later(EVERY + 1_000))).toBe(0);
    expect(reads).toHaveLength(2);
  });

  it("prunes the entries past keepFor after a periodic reconciliation, never after a start or a failure", async () => {
    const pruned: string[] = [];
    const prune: ForgetLedger["prune"] = async ({ before }) => {
      pruned.push(before);
    };
    const { reconciliation } = await periodic({ prune, keepForMs: 60_000, failures: 1 });
    expect(await reconciliation.reconcile(NOW)).toEqual({ failed: new Error("down") });
    await reconciliation.reconcile(NOW);
    expect(pruned).toEqual([]);
    expect(await reconciliation.sweep(later(EVERY))).toBe(0);
    expect(pruned).toEqual([new Date(NOW.getTime() + EVERY - 60_000).toISOString()]);
    const failing = await periodic({ prune, keepForMs: 60_000 });
    await failing.reconciliation.reconcile(NOW);
    const down = await periodic({ prune, keepForMs: 60_000, failures: 2 });
    await down.reconciliation.reconcile(NOW);
    await down.reconciliation.sweep(later(EVERY));
    expect(pruned).toHaveLength(1);
    const keeping = await periodic({ prune });
    await keeping.reconciliation.reconcile(NOW);
    await keeping.reconciliation.sweep(later(EVERY));
    expect(pruned).toHaveLength(1);
  });
});

describe("forgetAgain", () => {
  it("refuses an entry without a person's id", async () => {
    const storage = await memory().createStorage();
    const refused = forgetAgain({
      storage,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      concurrencyRetries: 3,
      entry: { personId: "" },
    });
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toThrow("forgetting again needs the id of the person");
  });

  it("takes no transaction for a person it has nothing to forget", async () => {
    const storage = await memory().createStorage();
    let transactions = 0;
    const counted: Storage = {
      ...storage,
      transact: (work) => {
        transactions += 1;
        return storage.transact(work);
      },
    };
    const run = (entry: ForgetAgainEntry) =>
      forgetAgain({
        storage: counted,
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
        concurrencyRetries: 3,
        entry,
      });
    expect(await run({ personId: "c-1", eventId: "e-1" })).toBeNull();
    expect(transactions).toBe(0);
    await keyed(storage, ["c-1"]);
    expect(await run({ personId: "c-1", eventId: "e-1" })).not.toBeNull();
    expect(transactions).toBe(1);
  });
});
