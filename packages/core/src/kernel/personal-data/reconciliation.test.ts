import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ReadForgetLedgerArgs,
} from "../../adapter/storage/forget-ledger.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ForgetLedgerUnavailableError, ValidationError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type LogFields, type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { withoutLedger } from "../test-support.ts";
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
    intentions: withoutLedger({ ids: createSequentialIdGenerator(), clock: createFixedClock(NOW) }),
    retentionDue: NEVER_DUE,
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
      intentions: withoutLedger({
        ids: createSequentialIdGenerator(),
        clock: createFixedClock(NOW),
      }),
      retentionDue: NEVER_DUE,
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
      logger: loggingErrors(errors),
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
      expect((await storage.personalKeys.get("c-1")) === null).toBe(forgotten === 1);
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
    expect(await storage.personalKeys.get("c-2")).not.toBeNull();
    expect(reconciliation.nextDueAt()).toEqual(
      new Date(Date.parse(younger) + FORGET_LEDGER_GRACE_MS),
    );
    expect(await storage.checkpointStore.get(FORGET_LEDGER_CURSOR)).toBe(Date.parse(younger));
    const due = new Date(Date.parse(younger) + FORGET_LEDGER_GRACE_MS);
    expect(await reconciliation.sweep(due)).toBe(2);
    expect(reconciliation.nextDueAt()).toBeNull();
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
    expect(await storage.personalKeys.get("c-1")).not.toBeNull();
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("leaves a key the entry does not name, and a person a store holds the forgetting of", async () => {
    const { storage, run } = await ledgered();
    await keyed(storage, ["c-1"]);
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-other"] })).toBeNull();
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-c-1"] })).not.toBeNull();
    await keyed(storage, ["c-1"]);
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-c-1"] })).toBeNull();
    expect(await storage.personalKeys.get("c-1")).not.toBeNull();
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
    expect(await storage.personalKeys.get("c-1")).not.toBeNull();
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
      await storage.personalKeys.remove("c-1");
      await storage.personalKeys.add("c-1", { key: "k-2", fingerprint: "f-2", kid: null });
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
      reconcileEveryMs: EVERY,
      keepForMs: null,
    });
    expect(await reconciliation.reconcile(NOW)).toBe(1);
    expect(recorded).toEqual([]);
  });

  it("never commits again a forgetting the retention made without a retention", async () => {
    expect(await NEVER_DUE(await memory().createStorage(), "c-1", NOW)).toBe(false);
  });

  it("forgets nobody whose key went between its check and its transaction", async () => {
    const { storage, run, beforeTransaction } = await ledgered();
    await keyed(storage, ["c-1"]);
    beforeTransaction(async () => {
      await storage.personalKeys.remove("c-1");
    });
    expect(await run({ ...entry("c-1", "e-1", at(3)), fingerprints: ["f-c-1"] })).toBeNull();
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });
});
