import type { Storage } from "../../adapter/adapter.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ForgetLedgerPosition,
} from "../../adapter/storage/forget-ledger.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import { BOUNDA_AGGREGATE } from "../../modules/bounda-events.ts";
import { startedBy } from "../shared/causation.ts";
import { errorDetails } from "../shared/retry.ts";
import { type Forgotten, forgetWithin, logForgotten } from "./forget.ts";
import { checkPersonId, transactRetrying } from "./transact.ts";

/**
 * The checkpoint row that keeps, in milliseconds, the time of the last ledger entry the database
 * has applied: it goes back with a restored copy, to where that copy stood.
 */
export const FORGET_LEDGER_CURSOR = "forget-ledger:applied";

// How far before the cursor a reconciliation reads the ledger again: entries come in the order of
// their time, which the clocks of several instances, and a forget committed a moment after it was
// timed, may set slightly out of the order they were written in. Reading an entry the database
// holds already changes nothing.
export const FORGET_LEDGER_REREAD_MS: number = 15 * 60_000;

// How long a reconciliation that failed waits, twice as long after each failure up to
// `FORGET_LEDGER_MAX_RETRY_MS`.
export const FORGET_LEDGER_RETRY_MS = 30_000;

export const FORGET_LEDGER_MAX_RETRY_MS = 3_600_000;

// How many entries a reconciliation reads at once: a store that lists from its newest entry, as
// KV does, lists again for every page.
export const FORGET_LEDGER_PAGE = 1_000;

// How long the start waits for the reconciliation before it serves and lets it finish behind.
export const FORGET_LEDGER_START_TIMEOUT_MS = 10_000;

export interface ForgetAgainEntry {
  readonly personId: string;
  /**
   * The `PersonalDataForgotten` the person was forgotten by: a store that holds it has applied the
   * forgetting already, and a key the person holds now was given to them after.
   */
  readonly eventId?: string;
}

export interface ForgetAgainArgs {
  readonly storage: Pick<Storage, "transact" | "eventStore" | "personalKeys">;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly concurrencyRetries: number;
  readonly entry: ForgetAgainEntry;
}

export interface ForgetAgainFunction {
  (args: ForgetAgainArgs): Promise<Forgotten | null>;
}

/**
 * Forgets the person again, with `reason: "restored"`, when the store does not hold the event the
 * entry names and the person still holds a key, deciding both again in the transaction that
 * forgets them, so of two instances doing it at once, the one whose append conflicts finds the key
 * gone on its retry; an entry that reads as applied takes no transaction. Resolves `null` when it
 * forgot nobody. `storage` is the store as written: nothing here reads a personal field.
 */
export const forgetAgain: ForgetAgainFunction = async ({
  storage,
  ids,
  clock,
  concurrencyRetries,
  entry: { personId, eventId },
}) => {
  checkPersonId(personId, "forgetting again");
  const isDue = async (stores: Pick<Storage, "eventStore" | "personalKeys">): Promise<boolean> => {
    if (eventId !== undefined) {
      const applied = await stores.eventStore.readOne({
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: personId,
        eventId,
      });
      if (applied !== null) return false;
    }
    return (await stores.personalKeys.get(personId)) !== null;
  };
  if (!(await isDue(storage))) return null;
  const correlationId = ids.next();
  return transactRetrying({
    storage,
    concurrencyRetries,
    work: async (transaction) => {
      if (!(await isDue(transaction))) return null;
      return forgetWithin({
        transaction,
        ids,
        clock,
        personId,
        reason: "restored",
        context: startedBy(correlationId, undefined),
      });
    },
  });
};

export interface ForgetLedgerReconciliation {
  /**
   * Reads the ledger past the database's cursor and forgets again whom `forgetAgain` finds; then
   * moves the cursor. Resolves to how many persons it forgot, or `null` when it could not read
   * the ledger through; never rejects: a failure is logged and the worker tries again later.
   */
  reconcile(now: Date): Promise<number | null>;
  /**
   * Reconciles when a reconciliation is due, after a failure or once the ledger's
   * `visibilityDelayMs` has passed since the first, and resolves to how many persons it forgot.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next reconciliation is due; `null` when none is.
   */
  nextDueAt(): Date | null;
  /**
   * Whether the last reconciliation read the ledger through: `false` until the first one has,
   * and after one that failed.
   */
  reconciled(): boolean;
}

export interface CreateForgetLedgerReconciliationArgs {
  readonly ledger: ForgetLedger;
  /**
   * The store as written.
   */
  readonly storage: Pick<Storage, "transact" | "checkpointStore" | "eventStore" | "personalKeys">;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  /**
   * Defaults to `FORGET_LEDGER_PAGE`.
   */
  readonly pageSize?: number;
}

export interface CreateForgetLedgerReconciliationFunction {
  (args: CreateForgetLedgerReconciliationArgs): ForgetLedgerReconciliation;
}

/**
 * After a normal start the ledger holds little past the cursor; after a restore, the cursor went
 * back with the copy, and the read returns the forgettings made since, which the copy does not
 * hold. The cursor only moves forward, so two instances reconciling at once never move it back.
 */
export const createForgetLedgerReconciliation: CreateForgetLedgerReconciliationFunction = ({
  ledger,
  storage,
  ids,
  clock,
  logger,
  concurrencyRetries,
  pageSize = FORGET_LEDGER_PAGE,
}) => {
  const { checkpointStore } = storage;
  let done = false;
  let failures = 0;
  let dueAt: number | null = null;
  let settled = ledger.visibilityDelayMs === undefined || ledger.visibilityDelayMs <= 0;

  const advance = async (to: number): Promise<void> => {
    for (;;) {
      const at = await checkpointStore.get(FORGET_LEDGER_CURSOR);
      if (at >= to || (await checkpointStore.compareAndSet(FORGET_LEDGER_CURSOR, at, to))) return;
    }
  };

  const run = async (): Promise<number> => {
    const cursor = await checkpointStore.get(FORGET_LEDGER_CURSOR);
    let after: ForgetLedgerPosition | undefined =
      cursor === 0
        ? undefined
        : { forgottenAt: new Date(cursor - FORGET_LEDGER_REREAD_MS).toISOString(), eventId: "" };
    let forgotten = 0;
    for (;;) {
      const page: readonly ForgetLedgerEntry[] = await ledger.read({
        ...(after === undefined ? {} : { after }),
        limit: pageSize,
      });
      for (const entry of page) {
        const again = await forgetAgain({ storage, ids, clock, concurrencyRetries, entry });
        if (again === null) continue;
        logForgotten(logger, again);
        forgotten += 1;
      }
      const last = page.at(-1);
      if (last === undefined) return forgotten;
      const time = Date.parse(last.forgottenAt);
      if (Number.isFinite(time)) await advance(time);
      if (page.length < pageSize) return forgotten;
      after = last;
    }
  };

  const reconcile = async (now: Date): Promise<number | null> => {
    const at = now.getTime();
    try {
      const forgotten = await run();
      if (forgotten > 0)
        logger.warn("forgot again persons a restored backup brought back", { forgotten });
      done = true;
      failures = 0;
      dueAt = settled ? null : at + (ledger.visibilityDelayMs ?? 0);
      settled = true;
      return forgotten;
    } catch (error) {
      done = false;
      failures += 1;
      dueAt =
        at + Math.min(FORGET_LEDGER_RETRY_MS * 2 ** (failures - 1), FORGET_LEDGER_MAX_RETRY_MS);
      logger.error(
        "forget ledger could not be reconciled; persons a restored backup brought back are not forgotten yet",
        errorDetails(error),
      );
      return null;
    }
  };

  return {
    reconcile,
    sweep: async (now) => {
      if (dueAt === null || now.getTime() < dueAt) return 0;
      return (await reconcile(now)) ?? 0;
    },
    nextDueAt: () => (dueAt === null ? null : new Date(dueAt)),
    reconciled: () => done,
  };
};
