import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
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
import {
  createForgetLedgerReconciliation,
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_REREAD_MS,
  type ForgetAgainEntry,
  forgetAgain,
} from "./reconciliation.ts";

const NOW = new Date("2026-03-01T00:00:00.000Z");

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

  it("is not reconciled before its first reconciliation, nor due again after one", async () => {
    const { reconciliation, reads } = await setUp({ entries: [] });
    expect(reconciliation.reconciled()).toBe(false);
    expect(reconciliation.nextDueAt()).toBeNull();
    expect(await reconciliation.sweep(NOW)).toBe(0);
    expect(reads).toEqual([]);
    await reconciliation.reconcile(NOW);
    expect(reconciliation.reconciled()).toBe(true);
    expect(reconciliation.nextDueAt()).toBeNull();
    expect(await reconciliation.sweep(new Date(NOW.getTime() + 3_600_000))).toBe(0);
    expect(reads).toHaveLength(1);
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
      pageSize: 10,
    });
    expect(await reconciliation.reconcile(NOW)).toBeNull();
    const due = reconciliation.nextDueAt() as Date;
    expect(await reconciliation.sweep(due)).toBe(1);
  });

  it("warns only when it forgot someone", async () => {
    const warnings: unknown[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    const { reconciliation } = await setUp({ entries: [entry("c-1", "e-1", at(0))], logger });
    await reconciliation.reconcile(NOW);
    expect(warnings).toEqual([]);
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
