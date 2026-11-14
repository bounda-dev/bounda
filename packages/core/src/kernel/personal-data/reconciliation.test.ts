import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ReadForgetLedgerArgs,
} from "../../adapter/storage/forget-ledger.ts";
import { testPersonalKey } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ForgetLedgerUnavailableError, ValidationError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type LogFields, type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger, withoutLedger } from "../test-support.ts";
import { buildPersonalCategories } from "./categories.ts";
import { boundForgetLedger } from "./forget-ledger.ts";
import { HOLD_MS } from "./hold.ts";
import { createForgetIntentions } from "./intention.ts";
import {
  createForgetLedgerReconciliation,
  FORGET_LEDGER_ATTEMPTS,
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_GRACE_MS,
  FORGET_LEDGER_HELD_UNTIL,
  FORGET_LEDGER_LAST_RUN,
  FORGET_LEDGER_REREAD_MS,
  type ForgetAgainEntry,
  forgetAgain,
  NEVER_DUE,
} from "./reconciliation.ts";

// Each error line as its message, marked when it carries no error.
const loggingErrors = (errors: unknown[]): Logger => ({
  ...silentLogger,
  error: (message: string, fields?: LogFields) => {
    errors.push(fields?.error instanceof Error ? message : `${message} (without its error)`);
  },
});

const NOW = new Date("2026-03-01T00:00:00.000Z");
const NO_CATEGORIES = buildPersonalCategories({ module: undefined, retention: null });
const EVERY = 5 * 60_000;

const keyed = async (storage: Storage, persons: readonly string[]): Promise<void> => {
  for (const person of persons) {
    await storage.transact((transaction) =>
      transaction.personalKeys.add(person, "default", {
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
    readMark: async () => 0,
    raiseMark: async () => undefined,
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
    intentions: withoutLedger({ ids: createSequentialIdGenerator(), clock: createFixedClock(NOW) }),
    retentionDue: NEVER_DUE,
    ledger,
    storage,
    ids: createSequentialIdGenerator(),
    clock: createFixedClock(NOW),
    logger,
    concurrencyRetries: 3,
    categories: NO_CATEGORIES,
    batchSize: 10,
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
  categories: null,
  reason: "requested",
});

// Minutes into the hour before `NOW`: every entry is past the grace a reconciliation gives.
const at = (minute: number): string =>
  new Date(NOW.getTime() - 60 * 60_000 + minute * 60_000).toISOString();

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

  it("skips a redaction the ledger holds when it is given nothing to redact with", async () => {
    const { reconciliation, storage } = await setUp({
      entries: [
        {
          ...entry("c-1", "d-1", at(1)),
          redaction: {
            events: [
              { id: "e-1", aggregateType: "c", aggregateId: "c-1", type: "T", fields: ["f"] },
            ],
          },
        },
      ],
      persons: ["c-1"],
    });
    expect(await reconciliation.reconcile(NOW)).toBe(0);
    expect(await storage.eventStore.lastPosition()).toBe(0);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_CURSOR)).toBe(Date.parse(at(1)));
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
      Date.parse(at(0)) + FORGET_LEDGER_REREAD_MS,
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
      intentions: withoutLedger({
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
      }),
      retentionDue: NEVER_DUE,
      ledger: {
        readMark: async () => 0,
        raiseMark: async () => undefined,
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
      categories: NO_CATEGORIES,
      batchSize: 10,
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
      intentions: withoutLedger({
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
      }),
      retentionDue: NEVER_DUE,
      ledger: {
        readMark: async () => 0,
        raiseMark: async () => undefined,
        append: async () => {},
        read: async () => {
          reads += 1;
          throw new Error("down");
        },
      },
      storage: { ...storage, checkpointStore: checkpoints },
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger: loggingErrors(errors),
      concurrencyRetries: 3,
      categories: NO_CATEGORIES,
      batchSize: 10,
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
        intentions: withoutLedger({
          ids: createSequentialIdGenerator(),
          clock: createFixedClock(NOW),
        }),
        retentionDue: NEVER_DUE,
        ledger: recordingLedger([]).ledger,
        storage: { ...storage, checkpointStore: checkpoints },
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
        logger: loggingErrors(errors),
        concurrencyRetries: 3,
        categories: NO_CATEGORIES,
        batchSize: 10,
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
      intentions: withoutLedger({
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
      }),
      retentionDue: NEVER_DUE,
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
      categories: NO_CATEGORIES,
      batchSize: 10,
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
      intentions: withoutLedger({
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
      }),
      retentionDue: NEVER_DUE,
      ledger: recordingLedger([entry("c-1", "e-1", at(0))]).ledger,
      storage,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger: silentLogger,
      concurrencyRetries: 3,
      categories: NO_CATEGORIES,
      batchSize: 10,
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
      intentions: withoutLedger({
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
      }),
      retentionDue: NEVER_DUE,
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
      categories: NO_CATEGORIES,
      batchSize: 10,
      reconcileEveryMs: EVERY,
      keepForMs,
    });
    const fail = (times: number): void => {
      left = times;
    };
    return { storage, reconciliation, reads, fail };
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
      logger: loggingErrors(errors),
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
    failing.fail(1);
    expect(await failing.reconciliation.sweep(later(EVERY))).toBe(0);
    expect(failing.reads).toHaveLength(2);
    expect(pruned).toHaveLength(1);
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

describe("what the reconciliation commits again", () => {
  const named = (fingerprints: readonly string[] | undefined, minute = 0): ForgetLedgerEntry => ({
    ...entry("c-1", `e-${String(fingerprints)}`, at(minute)),
    ...(fingerprints === undefined ? {} : { fingerprints }),
  });

  it("commits a forgetting while the person holds a key it names, or any key when it names none recorded", async () => {
    for (const [fingerprints, forgotten] of [
      [["f-c-1"], 1],
      [["f-other", "f-c-1"], 1],
      [undefined, 1],
      [["f-other"], 0],
      [[], 0],
    ] as const) {
      const { reconciliation, storage } = await setUp({
        entries: [named(fingerprints)],
        persons: ["c-1"],
      });
      expect(await reconciliation.reconcile(NOW)).toBe(forgotten);
      expect((await storage.personalKeys.get("c-1", "default")) === null).toBe(forgotten === 1);
    }
  });

  it("commits it under its own id, time and reason, naming the key it destroyed", async () => {
    const retained = named(["f-c-1"], 7);
    const { reconciliation, storage } = await setUp({ entries: [retained], persons: ["c-1"] });
    await reconciliation.reconcile(NOW);
    expect(await storage.eventStore.readAll({ afterPosition: 0, limit: 10 })).toMatchObject([
      {
        id: retained.eventId,
        timestamp: retained.forgottenAt,
        aggregateType: "bounda",
        aggregateId: "c-1",
        person: "c-1",
        payload: { personId: "c-1", reason: "requested", fingerprints: ["f-c-1"] },
      },
    ]);
  });

  it("commits a forgetting the retention made only while the retention would forget the person now", async () => {
    const due: string[] = [];
    for (const [answer, forgotten] of [
      [false, 0],
      [true, 1],
    ] as const) {
      const storage = await memory().createStorage();
      await keyed(storage, ["c-1"]);
      const clock = createFixedClock(NOW);
      const reconciliation = createForgetLedgerReconciliation({
        ledger: recordingLedger([{ ...named(["f-c-1"]), reason: "retention" }]).ledger,
        intentions: withoutLedger({ ids: createSequentialIdGenerator(), clock }),
        retentionDue: async (_, personId, now) => {
          due.push(`${personId} ${now.toISOString()}`);
          return answer;
        },
        storage,
        ids: createSequentialIdGenerator(),
        clock,
        logger: silentLogger,
        concurrencyRetries: 3,
        categories: NO_CATEGORIES,
        batchSize: 10,
        reconcileEveryMs: EVERY,
        keepForMs: null,
      });
      expect(await reconciliation.reconcile(NOW)).toBe(forgotten);
    }
    // Once before the transaction, and once more in it for the one it forgot.
    expect(due).toEqual([
      `c-1 ${NOW.toISOString()}`,
      `c-1 ${NOW.toISOString()}`,
      `c-1 ${NOW.toISOString()}`,
    ]);
  });

  it("leaves an entry younger than its grace for a reconciliation due once the youngest comes of age", async () => {
    const young = new Date(NOW.getTime() - FORGET_LEDGER_GRACE_MS + 1).toISOString();
    const younger = new Date(NOW.getTime() - FORGET_LEDGER_GRACE_MS + 2).toISOString();
    const { reconciliation, storage } = await setUp({
      entries: [
        entry("c-1", "e-1", at(0)),
        entry("c-2", "e-2", young),
        entry("c-3", "e-3", younger),
      ],
      persons: ["c-1", "c-2", "c-3"],
    });
    expect(await reconciliation.reconcile(NOW)).toBe(1);
    expect(await storage.personalKeys.get("c-2", "default")).not.toBeNull();
    expect(reconciliation.nextDueAt()).toEqual(
      new Date(Date.parse(younger) + FORGET_LEDGER_GRACE_MS),
    );
    expect(await storage.checkpointStore.get(FORGET_LEDGER_CURSOR)).toBe(Date.parse(younger));
    const due = new Date(Date.parse(younger) + FORGET_LEDGER_GRACE_MS);
    expect(await reconciliation.sweep(due)).toBe(2);
    expect(reconciliation.nextDueAt()).toBeNull();
  });

  it("commits a young entry at once after a restore, and gives the grace again after that", async () => {
    const young = new Date(NOW.getTime() - 1).toISOString();
    const entries: ForgetLedgerEntry[] = [entry("c-1", "e-1", young)];
    const { reconciliation, storage } = await setUp({ entries, persons: ["c-1", "c-2"] });
    await reconciliation.restored(false);
    expect(await reconciliation.reconcile(NOW)).toBe(1);
    entries.push(entry("c-2", "e-2", young));
    expect(await reconciliation.reconcile(NOW)).toBe(0);
    expect(await storage.personalKeys.get("c-2", "default")).not.toBeNull();
  });

  it("is due at the sooner of a ledger's delay and an entry's grace", async () => {
    const young = new Date(NOW.getTime() - 1).toISOString();
    const late = await setUp({ entries: [entry("c-1", "e-1", young)], visibilityDelayMs: 1_000 });
    await late.reconciliation.reconcile(NOW);
    expect(late.reconciliation.nextDueAt()).toEqual(new Date(NOW.getTime() + 1_000));
    const slow = await setUp({
      entries: [entry("c-1", "e-1", young)],
      visibilityDelayMs: 10 * FORGET_LEDGER_GRACE_MS,
    });
    await slow.reconciliation.reconcile(NOW);
    expect(slow.reconciliation.nextDueAt()).toEqual(
      new Date(Date.parse(young) + FORGET_LEDGER_GRACE_MS),
    );
  });
});

describe("forgetAgain", () => {
  it("refuses an entry without a person's id", async () => {
    const storage = await memory().createStorage();
    const ids = createSequentialIdGenerator();
    const clock = createFixedClock(NOW);
    const refused = forgetAgain({
      storage,
      intentions: withoutLedger({ ids, clock }),
      ids,
      clock,
      concurrencyRetries: 3,
      categories: NO_CATEGORIES,
      batchSize: 10,
      entry: { personId: "" },
      retentionDue: NEVER_DUE,
      record: true,
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
    const ids = createSequentialIdGenerator();
    const clock = createFixedClock(NOW);
    const run = (entry: ForgetAgainEntry) =>
      forgetAgain({
        storage: counted,
        intentions: withoutLedger({ ids, clock }),
        ids,
        clock,
        concurrencyRetries: 3,
        categories: NO_CATEGORIES,
        batchSize: 10,
        entry,
        retentionDue: NEVER_DUE,
        record: true,
      });
    expect(await run({ personId: "c-1", eventId: "e-1" })).toBeNull();
    expect(transactions).toBe(0);
    await keyed(storage, ["c-1"]);
    expect(await run({ personId: "c-1", eventId: "e-1" })).not.toBeNull();
    expect(transactions).toBe(1);
  });

  it("forgets again only the categories the entry asked for, while one of them still has a key in force", async () => {
    const storage = await memory().createStorage();
    const categories = buildPersonalCategories({
      module: {
        categories: {
          profile: { basis: "consent", retention: "30d" },
          invoices: { basis: "legal-obligation", retention: "30d" },
        },
      },
      retention: null,
    });
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "profile", testPersonalKey("2"));
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("3"));
    await storage.personalKeys.retain("c-1", "f-3", { since: at(0), lastActiveAt: at(0) });
    const ids = createSequentialIdGenerator();
    const clock = createFixedClock(NOW);
    const run = (asked: readonly string[] | null) =>
      forgetAgain({
        storage,
        intentions: withoutLedger({ ids, clock }),
        ids,
        clock,
        concurrencyRetries: 3,
        categories,
        batchSize: 10,
        entry: { personId: "c-1", eventId: "e-1", categories: asked },
        retentionDue: NEVER_DUE,
        record: false,
      });
    expect(await run([])).toBeNull();
    expect(await run(["orders"])).toBeNull();
    expect(await run(["invoices"])).toBeNull();
    expect((await run(["profile", "orders"]))?.payload).toMatchObject({
      reason: "requested",
      whole: false,
      categories: ["profile"],
      retained: [],
    });
    expect((await storage.personalKeys.list("c-1")).map(({ category }) => category)).toEqual([
      "default",
      "invoices",
    ]);
    expect(await run(["profile"])).toBeNull();
    expect((await run(null))?.payload).toMatchObject({
      whole: true,
      categories: ["default", "profile"],
    });
    expect((await storage.personalKeys.list("c-1")).map(({ category }) => category)).toEqual([
      "invoices",
    ]);
    expect(await run(null)).toBeNull();
  });

  it("commits again a category's retention only while it would still end the keys it names, destroying those alone", async () => {
    const storage = await memory().createStorage();
    const categories = buildPersonalCategories({
      module: {
        categories: {
          profile: { basis: "consent", retention: "30d" },
          invoices: { basis: "legal-obligation", retention: "30d" },
        },
      },
      retention: null,
    });
    await storage.personalKeys.add("c-1", "default", testPersonalKey("1"));
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("3"));
    const asked: (readonly string[] | null)[] = [];
    let due = false;
    const ids = createSequentialIdGenerator();
    const clock = createFixedClock(NOW);
    const run = (entry: ForgetAgainEntry) =>
      forgetAgain({
        storage,
        intentions: withoutLedger({ ids, clock }),
        ids,
        clock,
        concurrencyRetries: 3,
        categories,
        batchSize: 10,
        entry,
        retentionDue: async (_stores, _person, _now, keys) => {
          asked.push(keys === null ? null : keys.map(({ key }) => key.fingerprint));
          return due;
        },
        record: false,
      });
    const entry: ForgetAgainEntry = {
      personId: "c-1",
      eventId: "e-1",
      forgottenAt: at(0),
      reason: "retention",
      categories: ["invoices"],
      fingerprints: ["f-3"],
    };
    expect(await run(entry)).toBeNull();
    expect(asked).toEqual([["f-3"]]);
    due = true;
    expect(
      (await run({ personId: "c-1", reason: "retention", categories: ["invoices"] }))?.payload,
    ).toMatchObject({
      reason: "retention",
      whole: false,
      categories: ["invoices"],
      retained: [],
      fingerprints: ["f-3"],
    });
    expect((await storage.personalKeys.list("c-1")).map(({ category }) => category)).toEqual([
      "default",
    ]);
    expect(await run(entry)).toBeNull();
    await storage.personalKeys.add("c-1", "invoices", testPersonalKey("4"));
    asked.length = 0;
    expect((await run({ personId: "c-1", reason: "retention" }))?.payload).toMatchObject({
      whole: true,
    });
    expect(asked).toEqual([null, null]);
  });

  const ledgered = async () => {
    const base = await memory().createStorage();
    let transactions = 0;
    const beforeTransaction: (() => Promise<void>)[] = [];
    const storage: Storage = {
      ...base,
      transact: async (work) => {
        transactions += 1;
        await beforeTransaction.shift()?.();
        return base.transact(work);
      },
    };
    const recorded: ForgetLedgerEntry[] = [];
    const ids = createSequentialIdGenerator();
    const clock = createFixedClock(NOW);
    let down = false;
    const intentions = createForgetIntentions({
      ledger: {
        store: boundForgetLedger({
          ledger: {
            readMark: async () => 0,
            raiseMark: async () => undefined,
            append: async (entries) => {
              if (down) throw new Error("ledger is down");
              recorded.push(...entries);
            },
            read: async () => [],
          },
          timeoutMs: 1_000,
          clock,
        }),
        strict: true,
      },
      ids,
      clock,
      logger: silentLogger,
    });
    const run = (entry: ForgetAgainEntry) =>
      forgetAgain({
        storage,
        intentions,
        ids,
        clock,
        concurrencyRetries: 3,
        categories: NO_CATEGORIES,
        batchSize: 10,
        entry,
        retentionDue: NEVER_DUE,
        record: true,
      });
    return {
      storage,
      recorded,
      run,
      intentions,
      ids,
      clock,
      transactions: () => transactions,
      beforeTransaction: (step: () => Promise<void>) => beforeTransaction.push(step),
      fail: () => {
        down = true;
      },
    };
  };

  it("records a whole entry from elsewhere in the ledger as it is, then commits it under its id", async () => {
    const { storage, recorded, run } = await ledgered();
    await keyed(storage, ["c-1", "c-2"]);
    const whole: ForgetLedgerEntry = { ...entry("c-1", "e-1", at(3)), fingerprints: ["f-c-1"] };
    const unrecorded = entry("c-2", "e-2", at(4));
    expect(await run(whole)).toMatchObject({ event: { id: "e-1", timestamp: at(3) } });
    expect(await run(unrecorded)).toMatchObject({ event: { id: "e-2" } });
    expect(recorded).toEqual([whole, unrecorded]);
    expect(recorded[1]).not.toHaveProperty("fingerprints");
  });

  it("takes an intention of its own for a bare id, naming the key the person holds, and none for one who holds none", async () => {
    const { storage, recorded, run } = await ledgered();
    await keyed(storage, ["c-1"]);
    expect(await run({ personId: "c-2" })).toBeNull();
    expect(await run({ personId: "c-1", eventId: "elsewhere" })).toMatchObject({
      event: { id: "id-2", payload: { reason: "requested", fingerprints: ["f-c-1"] } },
    });
    expect(recorded).toEqual([
      {
        personId: "c-1",
        categories: null,
        eventId: "id-2",
        forgottenAt: NOW.toISOString(),
        reason: "requested",
        fingerprints: ["f-c-1"],
      },
    ]);
  });

  it("forgets nobody, when strict, while the ledger does not take the entry", async () => {
    const { storage, run, fail } = await ledgered();
    await keyed(storage, ["c-1"]);
    fail();
    await expect(run({ ...entry("c-1", "e-1", at(3)) })).rejects.toBeInstanceOf(
      ForgetLedgerUnavailableError,
    );
    await expect(run({ personId: "c-1" })).rejects.toBeInstanceOf(ForgetLedgerUnavailableError);
    expect(await storage.personalKeys.get("c-1", "default")).not.toBeNull();
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("leaves a key the entry does not name, and a person a store holds the forgetting of", async () => {
    const { storage, run } = await ledgered();
    await keyed(storage, ["c-1"]);
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-other"] })).toBeNull();
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-c-1"] })).not.toBeNull();
    await keyed(storage, ["c-1"]);
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-c-1"] })).toBeNull();
    expect(await storage.personalKeys.get("c-1", "default")).not.toBeNull();
  });

  it("leaves a key the entry does not name without a transaction", async () => {
    const { storage, run, transactions } = await ledgered();
    await keyed(storage, ["c-1"]);
    const keying = transactions();
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-other"] })).toBeNull();
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: [] })).toBeNull();
    expect(transactions()).toBe(keying);
  });

  it("leaves an entry naming no keys whose forgetting the store holds, whatever key the person holds", async () => {
    const { storage, run } = await ledgered();
    await keyed(storage, ["c-1"]);
    const legacy = entry("c-1", "e-1", at(3));
    expect(await run(legacy)).not.toBeNull();
    await keyed(storage, ["c-1"]);
    expect(await run(legacy)).toBeNull();
    expect(await storage.personalKeys.get("c-1", "default")).not.toBeNull();
  });

  it("takes an intention of its own for an entry missing its id, its time or its reason", async () => {
    const { storage, recorded, run } = await ledgered();
    await keyed(storage, ["c-1", "c-2", "c-3"]);
    const { forgottenAt, eventId } = entry("c-1", "e-1", at(3));
    await run({ personId: "c-1", eventId, reason: "requested" });
    await run({ personId: "c-2", forgottenAt, reason: "requested" });
    await run({ personId: "c-3", eventId: "e-3", forgottenAt });
    expect(
      recorded.map(({ personId, eventId: id, forgottenAt: at, reason }) => [
        personId,
        id,
        at,
        reason,
      ]),
    ).toEqual([
      ["c-1", "id-2", NOW.toISOString(), "requested"],
      ["c-2", "id-4", NOW.toISOString(), "requested"],
      ["c-3", "id-6", NOW.toISOString(), "requested"],
    ]);
  });

  it("takes a new intention for a bare id when the person is given a key between the intention and the commit", async () => {
    const { storage, recorded, run, beforeTransaction } = await ledgered();
    await keyed(storage, ["c-1"]);
    beforeTransaction(async () => {
      await storage.personalKeys.remove("c-1", "f-c-1");
      await storage.personalKeys.add("c-1", "default", {
        key: "k-2",
        fingerprint: "f-2",
        kid: null,
      });
    });
    expect(await run({ personId: "c-1" })).toMatchObject({
      event: { id: "id-3", payload: { fingerprints: ["f-2"] } },
    });
    expect(recorded.map(({ eventId, fingerprints }) => [eventId, fingerprints])).toEqual([
      ["id-2", ["f-c-1"]],
      ["id-3", ["f-2"]],
    ]);
  });

  it("records nothing as it reconciles: the entries are the ledger's own", async () => {
    const { storage, recorded, intentions, ids, clock } = await ledgered();
    await keyed(storage, ["c-1"]);
    const reconciliation = createForgetLedgerReconciliation({
      ledger: recordingLedger([{ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-c-1"] }]).ledger,
      intentions,
      retentionDue: NEVER_DUE,
      storage,
      ids,
      clock,
      logger: silentLogger,
      concurrencyRetries: 3,
      categories: NO_CATEGORIES,
      batchSize: 10,
      reconcileEveryMs: EVERY,
      keepForMs: null,
    });
    expect(await reconciliation.reconcile(NOW)).toBe(1);
    expect(recorded).toEqual([]);
  });

  it("never commits again a forgetting the retention made without a retention", async () => {
    expect(await NEVER_DUE(await memory().createStorage(), "c-1", NOW, null)).toBe(false);
  });

  it("forgets nobody whose key went between its check and its transaction", async () => {
    const { storage, run, beforeTransaction } = await ledgered();
    await keyed(storage, ["c-1"]);
    beforeTransaction(async () => {
      await storage.personalKeys.remove("c-1", "f-c-1");
    });
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-c-1"] })).toBeNull();
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });
});

describe("the reconciliation's status and restores", () => {
  it("says where it stands from the database's rows, and that it read the ledger through", async () => {
    const { storage, reconciliation } = await setUp({ entries: [entry("c-1", "e-1", at(-5))] });
    expect(await reconciliation.status()).toEqual({
      reconciled: false,
      appliedThrough: null,
      lastRunAt: null,
      held: null,
    });
    await reconciliation.reconcile(NOW);
    expect(await reconciliation.status()).toEqual({
      reconciled: true,
      appliedThrough: at(-5),
      lastRunAt: NOW.toISOString(),
      held: null,
    });
    await storage.checkpointStore.set(FORGET_LEDGER_HELD_UNTIL, NOW.getTime() + 60_000);
    expect((await reconciliation.status()).held).toEqual({
      until: new Date(NOW.getTime() + 60_000).toISOString(),
      attempts: 0,
    });
    await storage.checkpointStore.remove(FORGET_LEDGER_HELD_UNTIL);
    await storage.checkpointStore.set(FORGET_LEDGER_ATTEMPTS, 1);
    expect((await reconciliation.status()).held).toEqual({
      until: new Date(0).toISOString(),
      attempts: 1,
    });
    await storage.checkpointStore.set(FORGET_LEDGER_ATTEMPTS, 2);
    await storage.checkpointStore.set(FORGET_LEDGER_HELD_UNTIL, NOW.getTime() + 60_000);
    expect((await reconciliation.status()).held).toEqual({
      until: new Date(NOW.getTime() + 60_000).toISOString(),
      attempts: 2,
    });
  });

  it("is due at once after a restore, and clears the copy's hold on the instance that found it first", async () => {
    const { storage, reconciliation } = await setUp({ entries: [] });
    await reconciliation.reconcile(NOW);
    expect(reconciliation.nextDueAt()).toBeNull();
    await storage.checkpointStore.set(FORGET_LEDGER_ATTEMPTS, 4);
    await storage.checkpointStore.set(FORGET_LEDGER_HELD_UNTIL, NOW.getTime() + 3_600_000);
    await reconciliation.restored(false);
    expect(reconciliation.nextDueAt()).toEqual(NOW);
    expect(reconciliation.reconciled()).toBe(false);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_ATTEMPTS)).toBe(4);
    await reconciliation.restored(true);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_ATTEMPTS)).toBe(0);
    expect(await storage.checkpointStore.get(FORGET_LEDGER_HELD_UNTIL)).toBe(0);
    expect(await reconciliation.sweep(NOW)).toBe(0);
    expect(reconciliation.reconciled()).toBe(true);
  });

  it("logs a hold it could not clear after a restore, and is due all the same", async () => {
    const storage = await memory().createStorage();
    const logged: unknown[][] = [];
    const reconciliation = createForgetLedgerReconciliation({
      ledger: recordingLedger([]).ledger,
      intentions: withoutLedger({
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
      }),
      retentionDue: NEVER_DUE,
      storage: {
        ...storage,
        checkpointStore: {
          ...storage.checkpointStore,
          get: () => Promise.reject(new Error("down")),
        },
      },
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(NOW),
      logger: { ...silentLogger, error: (...args: unknown[]) => logged.push(args) },
      concurrencyRetries: 3,
      categories: NO_CATEGORIES,
      batchSize: 10,
      reconcileEveryMs: EVERY,
      keepForMs: null,
    });
    await reconciliation.restored(true);
    expect(reconciliation.nextDueAt()).toEqual(NOW);
    expect(logged).toEqual([
      [
        "forget ledger's reconciliation hold could not be cleared",
        { error: expect.objectContaining({ message: "down" }) },
      ],
    ]);
  });
});

describe("the reconciliation of changes of restrictions", () => {
  const restricted = (
    personId: string,
    eventId: string,
    forgottenAt: string,
    restrictions: readonly { ground: "legal-claims"; categories: null; since: string }[],
  ): ForgetLedgerEntry => ({
    personId,
    eventId,
    forgottenAt,
    categories: null,
    reason: "requested",
    restriction: {
      type: "ProcessingRestricted",
      payload: { personId, ground: "legal-claims", categories: null, restrictions },
    },
  });

  it("commits again a change the store lost, with its id and time, counts it, and logs it", async () => {
    const at = new Date(NOW.getTime() - 120_000).toISOString();
    const { logger, entries: logs } = createRecordingLogger();
    const { storage, reconciliation } = await setUp({
      entries: [
        restricted("ana", "019a6b1e-0000-7000-8000-0000000000r1", at, [
          { ground: "legal-claims", categories: null, since: at },
        ]),
      ],
      logger,
    });
    expect(await reconciliation.reconcile(NOW)).toBe(1);
    expect(await storage.persons.restrictions("ana")).toEqual([
      { ground: "legal-claims", category: null, since: at },
    ]);
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    expect(event).toMatchObject({
      id: "019a6b1e-0000-7000-8000-0000000000r1",
      type: "ProcessingRestricted",
      timestamp: at,
      aggregateId: "ana",
    });
    expect(logs).toContainEqual({
      level: "info",
      message: "restriction committed again from the forget ledger",
      fields: {
        personId: "ana",
        eventId: "019a6b1e-0000-7000-8000-0000000000r1",
        eventType: "ProcessingRestricted",
      },
    });
    expect(await reconciliation.reconcile(new Date(NOW.getTime() + EVERY))).toBe(0);
  });
});
