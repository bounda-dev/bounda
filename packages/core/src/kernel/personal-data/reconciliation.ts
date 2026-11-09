import type { Storage } from "../../adapter/adapter.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ForgetLedgerPosition,
} from "../../adapter/storage/forget-ledger.ts";
import { type Hold, isReleasedBy } from "../../adapter/storage/hold.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import { BOUNDA_AGGREGATE } from "../../modules/bounda-events.ts";
import { startedBy } from "../shared/causation.ts";
import { type Forgotten, forgetWithin, logForgotten } from "./forget.ts";
import { holdAfter } from "./hold.ts";
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

/**
 * The checkpoint rows that keep the hold of a reconciliation that failed, beside its cursor: when
 * it ends, in milliseconds, and how many reconciliations failed in a row. Every instance waits for
 * it, and a restart backs off from where it was.
 */
export const FORGET_LEDGER_HELD_UNTIL = "forget-ledger:held-until";

export const FORGET_LEDGER_ATTEMPTS = "forget-ledger:attempts";

/**
 * The checkpoint row that keeps, in milliseconds, when an instance last took the periodic
 * reconciliation, or finished one at start: the others leave it until `reconcileEvery` after.
 */
export const FORGET_LEDGER_LAST_RUN = "forget-ledger:last-run";

// How many entries a reconciliation reads at once: a store that lists from its newest entry, as
// KV does, lists again for every page.
export const FORGET_LEDGER_PAGE = 1_000;

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
  readonly actor?: string | undefined;
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
  actor,
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
        context: startedBy(correlationId, actor),
      });
    },
  });
};

export interface ReconciliationFailed {
  readonly failed: unknown;
}

export interface ForgetLedgerReconciliation {
  /**
   * Reads the ledger past the database's cursor and forgets again whom `forgetAgain` finds; then
   * moves the cursor. Resolves to how many persons it forgot, or to why it could not read the
   * ledger through; never rejects: a failure is logged and the worker tries again later.
   */
  reconcile(now: Date): Promise<number | ReconciliationFailed>;
  /**
   * Reconciles when a reconciliation is due: after a failure, unless another instance's failure
   * holds it longer; once the ledger's `visibilityDelayMs` has passed since the first; or
   * `reconcileEvery` after the last one any instance took, which this one then takes, and prunes
   * the ledger after it. Resolves to how many persons it forgot.
   */
  sweep(now: Date): Promise<number>;
  /**
   * When the next reconciliation after a failure, or for a ledger's delay, is due; `null` when
   * none is. The periodic one is left out: a host that only wakes for it would never sleep.
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
  readonly reconcileEveryMs: number;
  /**
   * `null` keeps every entry.
   */
  readonly keepForMs: number | null;
  /**
   * Defaults to `FORGET_LEDGER_PAGE`.
   */
  readonly pageSize?: number;
  /**
   * Called with each person forgotten again, once their forgetting is committed.
   */
  readonly forgotten?: (personId: string) => void;
}

export interface CreateForgetLedgerReconciliationFunction {
  (args: CreateForgetLedgerReconciliationArgs): ForgetLedgerReconciliation;
}

/**
 * After a normal start the ledger holds little past the cursor; after a restore, the cursor went
 * back with the copy, and the read returns the forgettings made since, which the copy does not
 * hold. The cursor only moves forward, so two instances reconciling at once never move it back. A
 * failure holds the next reconciliation beside the cursor, longer after each failure in a row of
 * any instance, and the first that succeeds clears it; a start reconciles whatever the hold says.
 * The periodic reconciliation is shared the same way: the instance that finds it due takes it by
 * moving `FORGET_LEDGER_LAST_RUN`, which a restore also takes back, so the first instance due
 * after a restore made while the app runs reconciles.
 */
export const createForgetLedgerReconciliation: CreateForgetLedgerReconciliationFunction = ({
  ledger,
  storage,
  ids,
  clock,
  logger,
  concurrencyRetries,
  reconcileEveryMs,
  keepForMs,
  pageSize = FORGET_LEDGER_PAGE,
  forgotten: onForgotten,
}) => {
  const { checkpointStore } = storage;
  let done = false;
  let dueAt: number | null = null;
  // When this instance next looks whether the periodic reconciliation is due.
  let periodicAt: number = clock.now().getTime() + reconcileEveryMs;
  // The last hold this instance set, for when the store cannot say.
  let local: Hold | null = null;
  let settled = ledger.visibilityDelayMs === undefined || ledger.visibilityDelayMs <= 0;

  const advance = async (row: string, to: number): Promise<void> => {
    for (;;) {
      const at = await checkpointStore.get(row);
      if (at >= to || (await checkpointStore.compareAndSet(row, at, to))) return;
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
        onForgotten?.(entry.personId);
        forgotten += 1;
      }
      const last = page.at(-1);
      if (last === undefined) return forgotten;
      const time = Date.parse(last.forgottenAt);
      if (Number.isFinite(time)) await advance(FORGET_LEDGER_CURSOR, time);
      if (page.length < pageSize) return forgotten;
      after = last;
    }
  };

  // No row reads as a hold that ended long ago, after no failure.
  const storedHold = async (): Promise<Hold> => {
    const [until, attempts] = await Promise.all([
      checkpointStore.get(FORGET_LEDGER_HELD_UNTIL),
      checkpointStore.get(FORGET_LEDGER_ATTEMPTS),
    ]);
    return { until: new Date(until).toISOString(), attempts };
  };

  // A hold still running was set by another instance failing in the same round: this failure
  // waits for it rather than counting once more. The attempts are written first and cleared
  // first, so a hold half written counts one failure more than there was, and one half cleared
  // leaves only its end, which the next failure outlasts or waits for.
  const hold = async (at: number): Promise<void> => {
    const held = await storedHold().catch(() => local);
    if (held !== null && !isReleasedBy(held, new Date(at))) {
      local = held;
      dueAt = Date.parse(held.until);
      return;
    }
    local = holdAfter({ held, at, failed: true });
    dueAt = Date.parse(local.until);
    await checkpointStore.set(FORGET_LEDGER_ATTEMPTS, local.attempts);
    await checkpointStore.set(FORGET_LEDGER_HELD_UNTIL, dueAt);
  };

  const release = async (): Promise<void> => {
    local = null;
    const { until, attempts } = await storedHold();
    if (Date.parse(until) === 0 && attempts === 0) return;
    await checkpointStore.remove(FORGET_LEDGER_ATTEMPTS);
    await checkpointStore.remove(FORGET_LEDGER_HELD_UNTIL);
  };

  const reconcile = async (now: Date): Promise<number | ReconciliationFailed> => {
    const at = now.getTime();
    let forgotten: number;
    try {
      forgotten = await run();
    } catch (error) {
      done = false;
      logger.error(
        "forget ledger could not be reconciled; persons a restored backup brought back are not forgotten yet",
        { error },
      );
      await hold(at).catch((holdError: unknown) =>
        logger.error("forget ledger's reconciliation could not be held", { error: holdError }),
      );
      return { failed: error };
    }
    if (forgotten > 0)
      logger.warn("forgot again persons a restored backup brought back", { forgotten });
    done = true;
    dueAt = settled ? null : at + (ledger.visibilityDelayMs ?? 0);
    settled = true;
    periodicAt = at + reconcileEveryMs;
    await release().catch((error: unknown) =>
      logger.error("forget ledger's reconciliation hold could not be cleared", { error }),
    );
    await advance(FORGET_LEDGER_LAST_RUN, at).catch((error: unknown) =>
      logger.error("forget ledger's last reconciliation could not be kept", { error }),
    );
    return forgotten;
  };

  const prune = async (at: number): Promise<void> => {
    if (keepForMs === null || ledger.prune === undefined) return;
    try {
      await ledger.prune({ before: new Date(at - keepForMs).toISOString() });
    } catch (error) {
      logger.error("forget ledger could not be pruned", { error });
    }
  };

  // Resolves whether this instance takes the periodic reconciliation: none took it within
  // `reconcileEvery`, no failure holds it, and this one moved the row first. A store that cannot
  // say lets it run, as the reconciliation will find out.
  const takePeriodic = async (at: number): Promise<boolean> => {
    let last: number;
    let until: number;
    try {
      [last, until] = await Promise.all([
        checkpointStore.get(FORGET_LEDGER_LAST_RUN),
        checkpointStore.get(FORGET_LEDGER_HELD_UNTIL),
      ]);
    } catch {
      return true;
    }
    // A run more than a round ahead was written by a clock that runs ahead: left as it is, it would
    // hold every instance's rounds off until that clock's time comes.
    const next = last > at + reconcileEveryMs ? at : Math.max(last + reconcileEveryMs, until);
    if (next > at) {
      periodicAt = next;
      return false;
    }
    const taken = await checkpointStore
      .compareAndSet(FORGET_LEDGER_LAST_RUN, last, at)
      .catch(() => true);
    if (!taken) periodicAt = at + reconcileEveryMs;
    return taken;
  };

  const forgottenBy = (result: number | ReconciliationFailed): number =>
    typeof result === "number" ? result : 0;

  return {
    reconcile,
    sweep: async (now) => {
      const at = now.getTime();
      if (dueAt !== null && at >= dueAt) {
        // A retry after a failure: another instance's may hold it longer.
        if (local !== null) {
          // A store that cannot say lets this instance's own hold, which has ended, decide.
          const until = await storedHold().then(
            (held) => Date.parse(held.until),
            () => at,
          );
          if (until > at) {
            dueAt = until;
            return 0;
          }
        }
        return forgottenBy(await reconcile(now));
      }
      if (at < periodicAt || !(await takePeriodic(at))) return 0;
      const result = await reconcile(now);
      if (typeof result === "number") await prune(at);
      return forgottenBy(result);
    },
    nextDueAt: () => (dueAt === null ? null : new Date(dueAt)),
    reconciled: () => done,
  };
};
