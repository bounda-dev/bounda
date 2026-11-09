import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ForgetLedgerPosition,
} from "../../adapter/storage/forget-ledger.ts";
import { type Hold, isReleasedBy } from "../../adapter/storage/hold.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import { BOUNDA_AGGREGATE, type PersonalDataForgottenReason } from "../../modules/bounda-events.ts";
import { startedBy } from "../shared/causation.ts";
import { type Forgotten, forgetWithin, logForgotten, STALE_INTENTION } from "./forget.ts";
import { holdAfter } from "./hold.ts";
import type { ForgetIntention, ForgetIntentions } from "./intention.ts";
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

/**
 * How old a forget ledger's entry must be before a reconciliation commits it again: a younger one
 * may be the intention of a forgetting still committing. A reconciliation that leaves one is due
 * again once it is that old.
 */
export const FORGET_LEDGER_GRACE_MS: number = 60_000;

/**
 * A forgetting to commit again: a ledger's entry, or a line of `bounda forgotten`, or a bare
 * person's id.
 */
export interface ForgetAgainEntry {
  readonly personId: string;
  /**
   * The `PersonalDataForgotten` the person was forgotten by: a store that holds it has applied the
   * forgetting already. With `forgottenAt` and `reason`, it is committed again under the same id,
   * time and reason.
   */
  readonly eventId?: string;
  readonly forgottenAt?: string;
  readonly reason?: PersonalDataForgottenReason;
  /**
   * The keys the forgetting named: a key the person holds that is not here was given to them
   * after, and is kept. Any key counts when absent.
   */
  readonly fingerprints?: readonly string[];
}

/**
 * Whether the retention would forget the person now, read on the stores given: a forgetting the
 * retention made is committed again only then.
 */
export interface RetentionDueFunction {
  (
    stores: Pick<StorageTransaction, "persons" | "eventStore">,
    personId: string,
    now: Date,
  ): Promise<boolean>;
}

export const NEVER_DUE: RetentionDueFunction = async () => false;

export interface ForgetAgainArgs {
  readonly storage: Pick<Storage, "transact" | "eventStore" | "personalKeys" | "persons">;
  readonly intentions: ForgetIntentions;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly concurrencyRetries: number;
  readonly entry: ForgetAgainEntry;
  readonly retentionDue: RetentionDueFunction;
  /**
   * Whether the entry is written to the ledger first, as it is when it comes from elsewhere than
   * the ledger.
   */
  readonly record: boolean;
  readonly actor?: string | undefined;
}

export interface ForgetAgainFunction {
  (args: ForgetAgainArgs): Promise<Forgotten | null>;
}

type DueStores = Pick<StorageTransaction, "eventStore" | "personalKeys" | "persons">;

/**
 * Commits the forgetting again when the store does not hold the event the entry names, the person
 * still holds a key it names, and, for one the retention made, the retention would forget them
 * now; deciding all of it again in the transaction that forgets them, so of two instances doing
 * it at once, the one whose append conflicts finds it done on its retry. An entry that reads as
 * applied takes no transaction. A whole entry is committed under its own id, time and reason; any
 * other takes an intention of its own, as a request. Resolves `null` when it forgot nobody.
 * `storage` is the store as written: nothing here reads a personal field.
 */
export const forgetAgain: ForgetAgainFunction = async ({
  storage,
  intentions,
  ids,
  clock,
  concurrencyRetries,
  entry,
  retentionDue,
  record,
  actor,
}) => {
  const { personId, eventId, forgottenAt, reason, fingerprints } = entry;
  checkPersonId(personId, "forgetting again");
  const isDue = async (stores: DueStores, named: readonly string[] | undefined) => {
    if (eventId !== undefined) {
      const applied = await stores.eventStore.readOne({
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: personId,
        eventId,
      });
      if (applied !== null) return false;
    }
    const key = await stores.personalKeys.get(personId);
    if (key === null || (named !== undefined && !named.includes(key.fingerprint))) return false;
    return reason !== "retention" || retentionDue(stores, personId, clock.now());
  };
  if (!(await isDue(storage, fingerprints))) return null;
  const whole = eventId !== undefined && forgottenAt !== undefined && reason !== undefined;
  if (whole && record) {
    const recorded = { personId, eventId, forgottenAt, reason };
    await intentions.record(fingerprints === undefined ? recorded : { ...recorded, fingerprints });
  }
  const correlationId = ids.next();
  // A whole entry is due only while the person holds a key it names, so it is never stale; an
  // intention of its own takes another that names a key given meanwhile, as `forget` does.
  for (;;) {
    const intention: ForgetIntention = whole
      ? { eventId, forgottenAt, reason, fingerprints }
      : await intentions.intend({
          personId,
          reason: reason ?? "requested",
          keys: storage.personalKeys,
        });
    const outcome = await transactRetrying({
      storage,
      concurrencyRetries,
      work: async (transaction) =>
        (await isDue(transaction, fingerprints))
          ? forgetWithin({
              transaction,
              ids,
              clock,
              personId,
              intention,
              context: startedBy(correlationId, actor),
              checked: whole,
            })
          : null,
    });
    if (outcome !== STALE_INTENTION) return outcome === null || "held" in outcome ? null : outcome;
  }
};

export interface ReconciliationFailed {
  readonly failed: unknown;
}

export interface ForgetLedgerReconciliation {
  /**
   * Reads the ledger past the database's cursor and commits again what `forgetAgain` finds due,
   * leaving entries younger than `FORGET_LEDGER_GRACE_MS` to a reconciliation due once they are
   * not; then moves the cursor. Resolves to how many persons it forgot, or to why it could not read
   * the ledger through; never rejects: a failure is logged and the worker tries again later.
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
   * When the next reconciliation after a failure, for a ledger's delay or for an entry left for
   * being young, is due; `null` when none is. The periodic one is left out: a host that only wakes
   * for it would never sleep.
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
  readonly intentions: ForgetIntentions;
  readonly retentionDue: RetentionDueFunction;
  /**
   * The store as written.
   */
  readonly storage: ForgetAgainArgs["storage"] & Pick<Storage, "checkpointStore">;
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
  intentions,
  retentionDue,
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

  // Resolves how many it forgot, and when the youngest entry it left comes of age; the cursor
  // moves past that entry, which the next read takes again, since the grace is shorter than the
  // stretch read again.
  const run = async (at: number): Promise<{ forgotten: number; young: number | null }> => {
    const cursor = await checkpointStore.get(FORGET_LEDGER_CURSOR);
    let after: ForgetLedgerPosition | undefined =
      cursor === 0
        ? undefined
        : { forgottenAt: new Date(cursor - FORGET_LEDGER_REREAD_MS).toISOString(), eventId: "" };
    let forgotten = 0;
    let youngest: number | null = null;
    const ended = () => ({
      forgotten,
      young: youngest === null ? null : youngest + FORGET_LEDGER_GRACE_MS,
    });
    for (;;) {
      const page: readonly ForgetLedgerEntry[] = await ledger.read({
        ...(after === undefined ? {} : { after }),
        limit: pageSize,
      });
      for (const entry of page) {
        const time = Date.parse(entry.forgottenAt);
        if (time + FORGET_LEDGER_GRACE_MS > at) {
          // Entries come in the order of their time: the last one left is the youngest.
          youngest = time;
          continue;
        }
        const again = await forgetAgain({
          storage,
          intentions,
          ids,
          clock,
          concurrencyRetries,
          entry,
          retentionDue,
          record: false,
        });
        if (again === null) continue;
        logForgotten(logger, again);
        onForgotten?.(entry.personId);
        forgotten += 1;
      }
      const last = page.at(-1);
      if (last === undefined) return ended();
      const time = Date.parse(last.forgottenAt);
      if (Number.isFinite(time)) await advance(FORGET_LEDGER_CURSOR, time);
      if (page.length < pageSize) return ended();
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
    let young: number | null;
    try {
      ({ forgotten, young } = await run(at));
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
    if (forgotten > 0) {
      logger.warn("committed again forgettings the database did not hold", { forgotten });
    }
    done = true;
    const delayed = settled ? null : at + (ledger.visibilityDelayMs ?? 0);
    dueAt = delayed === null || young === null ? (delayed ?? young) : Math.min(delayed, young);
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
