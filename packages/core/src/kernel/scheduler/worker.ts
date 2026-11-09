import type {
  DeadLetterErrorType,
  NewDeadLetter,
} from "../../adapter/storage/dead-letter-store.ts";
import type { ClaimedCommand, ScheduledCommand } from "../../adapter/storage/scheduler.ts";
import type { ResolvedConfig, ResolvedRetryConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ScheduledClaimLostError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import {
  type CommandPipeline,
  RETRY_RESTRICTED_COMMAND,
  scheduledCommandId,
} from "../command/pipeline.ts";
import type { RestrictedRetries } from "../dead-letters/restricted.ts";
import type { DeadLetterRetention } from "../dead-letters/retention.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import type { PersonalDataBackfill } from "../personal-data/backfill.ts";
import { openCommandPayload } from "../personal-data/commands.ts";
import { sealError } from "../personal-data/errors.ts";
import { openedUnder } from "../personal-data/event-store.ts";
import { personOfEvent } from "../personal-data/persons.ts";
import type { ForgetLedgerReconciliation } from "../personal-data/reconciliation.ts";
import { restrictedPersonOf } from "../personal-data/refusal.ts";
import type { RetentionSweep } from "../personal-data/retention.ts";
import type { KeyRotation } from "../personal-data/rotation.ts";
import type { DelayedPolicies } from "../policy/delayed.ts";
import { PROCESS_DEADLINE_COMMAND, type ProcessDeadlinePayload } from "../process/deadlines.ts";
import type { ProcessDeadlines } from "../process/deliver-deadline.ts";
import { PROCESSES_SUBSCRIBER } from "../process/runner.ts";
import { createMutex } from "../shared/mutex.ts";
import type { RestoreWatch } from "../shared/restores.ts";
import { classifyFailure, errorIdentity, errorLabel, retryDelayMs } from "../shared/retry.ts";
import {
  appendSystemEvent,
  SCHEDULED_COMMAND_FAILED_EVENT,
  type ScheduledCommandFailedPayload,
} from "../system-events.ts";
import { ATTRIBUTES, actorAttribute, deadLettered, traced } from "../telemetry.ts";
import { commitWork, type UnitOfWork } from "../unit-of-work/unit-of-work.ts";

export interface ScheduledCommandWorker {
  start(): void;
  stop(): Promise<void>;
  /**
   * Resolves to how many entries it claimed, those it deferred included, persons it forgot for
   * the retention or again from the forget ledger, keys it rewrapped, resolved dead letters it
   * purged, and events and records the backfill of personal data walked past or resealed.
   */
  runOnce(): Promise<number>;
  /**
   * Outlasts the slowest handler timeout. A run renews its claim before each rerun after a
   * conflict, so the lease covers one run, not a batch; the store has no time limit, so a run can
   * still outlive it.
   */
  readonly leaseMs: number;
  /**
   * How many due deadlines and restricted retries wait for the reactive runners to catch up.
   */
  waitingDeadlines(): number;
  /**
   * Starts every background job over from what the database holds, as after a restore, between
   * passes; `first` also clears the holds the copy brought back, and `reconciled` leaves alone
   * the reconciliation that found it. Never rejects.
   */
  restored(first: boolean, options?: { readonly reconciled?: boolean }): Promise<void>;
}

export interface CreateScheduledCommandWorkerArgs {
  readonly storage: AppStorage;
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly processes: ProcessDeadlines;
  readonly delayedPolicies: DelayedPolicies;
  readonly restrictedRetries: RestrictedRetries;
  /**
   * Swept on every pass; absent without `runtime.personalData.retention`.
   */
  readonly retention?: RetentionSweep | undefined;
  /**
   * Swept on every pass; absent without `runtime.deadLetters.retention`.
   */
  readonly letterRetention?: DeadLetterRetention | undefined;
  /**
   * Swept on every pass; absent without `runtime.personalData.keyWrapper`.
   */
  readonly rotation?: KeyRotation | undefined;
  /**
   * Swept on every pass, which reconciles only when one is due; absent without
   * `runtime.personalData.forgetLedger`.
   */
  readonly reconciliation?: ForgetLedgerReconciliation | undefined;
  /**
   * Swept on every pass; absent when no schema marks personal data.
   */
  readonly backfill?: PersonalDataBackfill | undefined;
  /**
   * Checked on every pass: a database found gone back to an earlier copy has every background
   * job start over from what it holds, the attempts the jobs counted with it.
   */
  readonly restores?: RestoreWatch | undefined;
  /**
   * Called once a pass finds a restore, for what else counted attempts in this instance.
   */
  readonly onRestored?: (() => void) | undefined;
  /**
   * The reactive subscribers the dispatcher runs, by name: what a deadline and a restricted
   * retry wait for before they run.
   */
  readonly reactive: readonly string[];
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateScheduledCommandWorkerFunction {
  (args: CreateScheduledCommandWorkerArgs): ScheduledCommandWorker;
}

const CLAIM_LIMIT = 50;

/**
 * How often a worker that runs a pass purges the expired idempotency keys.
 */
export const IDEMPOTENCY_PURGE_INTERVAL_MS = 60_000;

/**
 * A renewal before a rerun that failed in the store: the store's failure, not the run's, so it is
 * neither retried nor dead-lettered as one.
 */
class RenewFailed extends Error {
  constructor(cause: unknown) {
    super(undefined, { cause });
  }
}

/**
 * Rounds a due deadline, or a restricted retry, waits for the reactive runners to catch up before
 * it runs anyway.
 */
export const DEADLINE_WAIT_ROUNDS = 10;

interface DeadlineWait {
  readonly head: number;
  readonly rounds: number;
}

/**
 * Runs scheduled commands, process deadlines and delayed policy runs, each claimed under a lease.
 * A run and the settling of its claim are one unit of work: what the run wrote and the claim's
 * completion land together, so a crash between them cannot run the command twice, a run whose
 * claim another instance took over writes nothing, and a give-up writes its dead letter with the
 * claim's failure. A deadline first waits for the process runner, so an event that cancels it is
 * seen first; this is best effort, since the aggregates still check what it sends. Deadline
 * entries are never removed here: the process runner writes what comes next, so a crash in between
 * leaves the entry to its lease instead of losing it. The entry `unrestrict` schedules retries the
 * dead letters the restriction caused, after the same wait, so the runners have refused what they
 * were going to; its letters are retried one by one, each in its own transaction, so a crash
 * leaves the entry to its lease and the next run finds the rest still `failed`. Every
 * `IDEMPOTENCY_PURGE_INTERVAL_MS` a pass also purges the idempotency keys that expired. Every pass
 * sweeps the retention, unless a list it could not read holds it: its read is one an index
 * answers, as `nextDueAt` is, so a host woken for a person's deadline forgets them in that pass.
 * The rotation of the key wrapper rewraps a batch of keys on every pass the same way, and the forget
 * ledger is reconciled again when the one the start ran failed, when its entries may show late, and
 * every `reconcileEvery`. The retention of dead letters purges the resolved ones on every pass the
 * same way, and the backfill seals a batch of what was written before the marks of now.
 */
export const createScheduledCommandWorker: CreateScheduledCommandWorkerFunction = ({
  storage,
  aggregates,
  pipeline,
  processes,
  delayedPolicies,
  restrictedRetries,
  retention,
  letterRetention,
  rotation,
  reconciliation,
  backfill,
  restores,
  onRestored,
  reactive,
  config,
  ids,
  clock,
  logger,
}) => {
  const mutex = createMutex();
  let cancelWait: (() => void) | undefined;
  let running = false;
  const timeoutMs = Math.max(
    ...[config.runtime, ...Object.values(config.runtime.overrides)].flatMap((runtime) => [
      runtime.commands.timeoutMs,
      runtime.policies.timeoutMs,
      runtime.processes.handlerTimeoutMs,
    ]),
  );
  const leaseMs = timeoutMs * 2;
  // An entry of a batch starts only this soon after the claim, so the entries behind it still hold
  // theirs when it ends, store time included, and go back unrun without an attempt instead of
  // lapsing into another worker's claim, which counts one.
  const startWithinMs = timeoutMs / 2;

  const waits = new Map<string, DeadlineWait>();
  let purgedAt = Number.NEGATIVE_INFINITY;

  const purgeExpiredKeys = async (now: Date): Promise<void> => {
    if (now.getTime() - purgedAt < IDEMPOTENCY_PURGE_INTERVAL_MS) return;
    purgedAt = now.getTime();
    try {
      const purged = await storage.idempotencyStore.purge({ now });
      if (purged > 0) logger.debug("expired idempotency keys purged", { purged });
    } catch (error) {
      logger.error("expired idempotency keys could not be purged", { error });
    }
  };

  const isDeadline = (entry: ScheduledCommand): boolean =>
    entry.command.type === PROCESS_DEADLINE_COMMAND;

  const deadlineOf = (entry: ScheduledCommand): ProcessDeadlinePayload =>
    entry.command.payload as ProcessDeadlinePayload;

  const isRestrictedRetry = (entry: ScheduledCommand): boolean =>
    entry.command.type === RETRY_RESTRICTED_COMMAND;

  // A deadline waits for the process runner; a restricted retry for every runner, since any of
  // them may still have a refusal to write.
  const runnersOf = (entry: ScheduledCommand): readonly string[] => {
    if (isDeadline(entry)) return reactive.filter((name) => name === PROCESSES_SUBSCRIBER);
    return isRestrictedRetry(entry) ? reactive : [];
  };

  const aggregateOf = (entry: ScheduledCommand): string | undefined =>
    aggregates.commandsByType[entry.command.type]?.aggregate.name;

  const retryOf = (entry: ScheduledCommand): ResolvedRetryConfig => {
    if (delayedPolicies.isDelayedPolicy(entry)) return delayedPolicies.retryOf(entry);
    if (isDeadline(entry)) return processes.retryOf(deadlineOf(entry).process);
    const aggregate = aggregateOf(entry);
    return aggregate === undefined
      ? config.runtime.policies.retry
      : config.forAggregate(aggregate).policies.retry;
  };

  const renew = async (entry: ClaimedCommand): Promise<void> => {
    try {
      await storage.scheduler.renew({ claim: entry, now: clock.now() });
    } catch (error) {
      throw error instanceof ScheduledClaimLostError ? error : new RenewFailed(error);
    }
  };

  const settled = (
    entry: ClaimedCommand,
    work: (unit: UnitOfWork) => Promise<void>,
  ): Promise<void> =>
    commitWork({
      storage,
      concurrencyRetries: config.runtime.commands.concurrencyRetries,
      work,
      beforeRerun: () => renew(entry),
    });

  const recordFailure = async (
    unit: UnitOfWork,
    entry: ScheduledCommand,
    error: unknown,
    attempts: number,
  ): Promise<void> => {
    const aggregateType = aggregateOf(entry);
    if (aggregateType === undefined) return;
    await appendSystemEvent({
      eventStore: unit.eventStore,
      ids,
      clock,
      aggregateType,
      aggregateId: entry.command.aggregateId,
      type: SCHEDULED_COMMAND_FAILED_EVENT,
      payload: {
        commandType: entry.command.type,
        ...errorIdentity(error),
        attempts,
      } satisfies ScheduledCommandFailedPayload,
      context: entry.context,
    });
  };

  // Whom the entry's work names: the person of the event a delayed policy ran on, as its handler
  // read it, or the one the payload was sealed for.
  const personOf = (
    entry: ScheduledCommand,
    event: StoredEvent | undefined,
    error: unknown,
  ): string | null => {
    const refused = restrictedPersonOf(error);
    if (refused !== null) return refused;
    if (!delayedPolicies.isDelayedPolicy(entry)) return entry.persons?.[0]?.person ?? null;
    return event === undefined ? null : personOfEvent({ aggregates, event });
  };

  const letterOf = async (
    entry: ScheduledCommand,
    error: unknown,
    attempts: number,
    reason: DeadLetterErrorType,
    event: StoredEvent | undefined,
  ): Promise<NewDeadLetter> => {
    const person = personOf(entry, event, error);
    // A scheduled command's payload needs nothing here: a forget cancels the command, so this run
    // has lost its claim and files no letter.
    const sealed = await sealError({
      error,
      person,
      keys: storage.personalKeys,
      read: event === undefined ? [] : openedUnder(event),
    });
    const now = clock.now().toISOString();
    if (delayedPolicies.isDelayedPolicy(entry)) {
      const payload = delayedPolicies.payloadOf(entry);
      return {
        id: ids.next(),
        kind: "policy",
        handler: payload.policy,
        eventId: payload.eventId,
        eventType: payload.eventType,
        aggregateType: payload.aggregateType,
        aggregateId: entry.command.aggregateId,
        person,
        errorType: reason,
        ...sealed,
        attempts,
        firstFailedAt: now,
        lastFailedAt: now,
      };
    }
    return {
      id: ids.next(),
      kind: "scheduled",
      handler: entry.command.type,
      eventId: entry.dedupeKey,
      eventType: entry.command.type,
      aggregateType: aggregateOf(entry) ?? "",
      aggregateId: entry.command.aggregateId,
      person,
      errorType: reason,
      ...sealed,
      attempts,
      firstFailedAt: now,
      lastFailedAt: now,
      payload: entry.command.payload,
      ...(entry.persons === undefined ? {} : { persons: entry.persons }),
    };
  };

  const dropped = (entry: ScheduledCommand, letter: NewDeadLetter, error: unknown): void => {
    deadLettered(letter);
    if (letter.kind === "policy") {
      logger.warn("policy dead-lettered", {
        policy: letter.handler,
        eventId: letter.eventId,
        letterId: letter.id,
        errorType: letter.errorType,
        attempts: letter.attempts,
        error,
      });
      return;
    }
    logger.warn("scheduled command dropped", {
      command: entry.command.type,
      dedupeKey: entry.dedupeKey,
      letterId: letter.id,
      reason: letter.errorType,
      attempts: letter.attempts,
      error,
    });
  };

  const giveUp = async (
    entry: ClaimedCommand,
    error: unknown,
    attempts: number,
    reason: DeadLetterErrorType,
    event: StoredEvent | undefined,
  ): Promise<void> => {
    if (isDeadline(entry)) {
      await processes.failDeadline({
        payload: deadlineOf(entry),
        error,
        attempts,
        errorType: reason,
        settle: (unit) => deferToItsTime(entry, unit),
      });
      return;
    }
    // The runtime's own entry gets no letter: the person's letters are still there, `failed`,
    // for an operator to retry, or for the next lift.
    if (isRestrictedRetry(entry)) {
      await storage.scheduler.fail({ claim: entry, error: errorLabel(errorIdentity(error)) });
      logger.error("restricted dead letters could not be retried; retry them by hand", {
        personId: entry.command.aggregateId,
        attempts,
        error,
      });
      return;
    }
    const letter = await letterOf(entry, error, attempts, reason, event);
    await settled(entry, async (unit) => {
      if (!delayedPolicies.isDelayedPolicy(entry))
        await recordFailure(unit, entry, error, attempts);
      await unit.deadLetterStore.add(letter);
      await unit.scheduler.fail({ claim: entry, error: errorLabel(letter) });
    });
    dropped(entry, letter, error);
  };

  const run = (
    entry: ClaimedCommand,
    unit: UnitOfWork,
    event: StoredEvent | undefined,
  ): Promise<void> =>
    traced({
      errorText: config.runtime.telemetry.errorText,
      name: `bounda.scheduled ${entry.command.type}`,
      attributes: {
        [ATTRIBUTES.commandType]: entry.command.type,
        [ATTRIBUTES.aggregateId]: entry.command.aggregateId,
        [ATTRIBUTES.correlationId]: entry.context.correlationId,
        [ATTRIBUTES.attempt]: entry.attempts + 1,
        ...actorAttribute(entry.context.actor),
      },
      run: async () => {
        if (delayedPolicies.isDelayedPolicy(entry)) {
          await delayedPolicies.run(entry, event, unit);
        } else if (isDeadline(entry)) {
          await processes.handleDeadline({
            payload: deadlineOf(entry),
            within: unit,
          });
        } else if (isRestrictedRetry(entry)) {
          await restrictedRetries.retryAll({
            personId: entry.command.aggregateId,
            unit,
            beforeEach: () => renew(entry),
            actor: entry.context.actor,
          });
        } else {
          const { payload, forgotten } = await openCommandPayload({
            payload: entry.command.payload,
            keys: storage.personalKeys,
          });
          // Its person was forgotten since the seal. A forget that cancelled the command leaves
          // this claim lost, so the run writes nothing; one that missed it, stored under a key the
          // forget removed after the seal read it, has it dropped here, never run.
          if (forgotten) {
            logger.warn("scheduled command dropped: its person was forgotten", {
              command: entry.command.type,
              dedupeKey: entry.dedupeKey,
            });
            return;
          }
          await pipeline.dispatchUnattended({
            type: entry.command.type,
            payload,
            context: entry.context,
            commandId: scheduledCommandId(entry.dedupeKey),
            within: unit,
          });
        }
      },
    });

  const deferToItsTime = (
    entry: ClaimedCommand,
    { scheduler }: Pick<UnitOfWork, "scheduler">,
  ): Promise<void> => scheduler.defer({ claim: entry, executeAt: new Date(entry.executeAt) });

  const execute = async (entry: ClaimedCommand): Promise<void> => {
    // Read once, so a give-up names the person the handler read, whatever a forget did since.
    let event: StoredEvent | undefined;
    try {
      if (delayedPolicies.isDelayedPolicy(entry)) event = await delayedPolicies.eventOf(entry);
      // Settled before the run stages anything, so a run that schedules or cancels its own key
      // does not make the claim look lost.
      await settled(entry, async (unit) => {
        if (isDeadline(entry)) await deferToItsTime(entry, unit);
        else await unit.scheduler.complete(entry);
        await run(entry, unit, event);
      });
    } catch (error) {
      if (error instanceof ScheduledClaimLostError || error instanceof RenewFailed) throw error;
      if (isDeadline(entry) && processes.lostRace(deadlineOf(entry), error)) {
        await deferToItsTime(entry, storage);
        return;
      }
      const attempts = entry.attempts + 1;
      const kind = classifyFailure(error);
      const retry = retryOf(entry);
      if (kind === "retriable" && retry.strategy !== "none" && attempts < retry.maxAttempts) {
        const retryAt = new Date(
          clock.now().getTime() + retryDelayMs({ retry, attempt: attempts }),
        );
        await storage.scheduler.fail({
          claim: entry,
          error: errorLabel(errorIdentity(error)),
          retryAt,
        });
        logger.warn("scheduled command failed; rescheduled", {
          command: entry.command.type,
          attempts,
          retryAt: retryAt.toISOString(),
          error,
        });
        return;
      }
      await giveUp(
        entry,
        error,
        attempts,
        kind === "terminal" ? "terminal" : "retriable_exhausted",
        event,
      );
    }
  };

  const isDeadlineReady = async (
    due: readonly ClaimedCommand[],
  ): Promise<(entry: ClaimedCommand) => boolean> => {
    const runners = [...new Set(due.flatMap(runnersOf))];
    if (runners.length === 0) return () => true;
    const [head, ...positions] = await Promise.all([
      storage.eventStore.lastPosition(),
      ...runners.map((name) => storage.checkpointStore.get(name)),
    ]);
    const positionOf = (entry: ClaimedCommand): number =>
      Math.min(...runnersOf(entry).map((name) => positions[runners.indexOf(name)] ?? 0));
    return (entry) => {
      if (runnersOf(entry).length === 0) return true;
      const wait = waits.get(entry.dedupeKey) ?? { head, rounds: 0 };
      if (positionOf(entry) >= wait.head || wait.rounds >= DEADLINE_WAIT_ROUNDS) {
        waits.delete(entry.dedupeKey);
        return true;
      }
      waits.set(entry.dedupeKey, { head: wait.head, rounds: wait.rounds + 1 });
      return false;
    };
  };

  // Claiming is a write the store runs as one statement; asked first, `nextDueAt` is a read its
  // indexes answer, so a pass that finds nothing due, most of them, writes nothing.
  const claimDue = async (now: Date): Promise<readonly ClaimedCommand[]> => {
    const next = await storage.scheduler.nextDueAt({ leaseMs });
    if (next === null || next.getTime() > now.getTime()) return [];
    return storage.scheduler.claimDue({ now, limit: CLAIM_LIMIT, leaseMs });
  };

  // The jobs' holds the copy brought back count failures it undid: the instance that found the
  // restore first clears them, and every one forgets what it knew of the jobs. Each never rejects.
  // `reconciled` when the reconciliation that just ran is what found the restore.
  const restart = async (first: boolean, reconciled = false): Promise<void> => {
    logger.warn("the database went back to an earlier copy; background jobs start over", {
      first,
    });
    purgedAt = Number.NEGATIVE_INFINITY;
    waits.clear();
    onRestored?.();
    letterRetention?.restored();
    await Promise.all([
      retention?.restored(first),
      rotation?.restored(first),
      reconciled ? undefined : reconciliation?.restored(first),
      backfill?.restored(first),
    ]);
  };

  // Whether the last pass did anything, which may have written no event: a key rewrapped, a hold.
  let worked = false;

  const runOnce = (): Promise<number> =>
    mutex.run(async () => {
      const restored = await restores?.check(clock.now(), { active: worked });
      if (restored !== undefined && restored !== null) await restart(restored.first);
      const claimedAt = clock.now();
      const due = await claimDue(claimedAt);
      // The batch is claimed already: an error escaping here would leave every entry to lapse, and
      // each would be charged an attempt it never made. Deadlines wait for the next round instead,
      // and the error ends this one once the rest has run.
      let unreadable: { readonly error: unknown } | undefined;
      const ready = await isDeadlineReady(due).catch((error: unknown) => {
        unreadable = { error };
        return (entry: ClaimedCommand) => runnersOf(entry).length === 0;
      });
      for (const entry of due) {
        try {
          const late = clock.now().getTime() - claimedAt.getTime() > startWithinMs;
          if (!late && ready(entry)) await execute(entry);
          else await deferToItsTime(entry, storage);
        } catch (error) {
          if (error instanceof ScheduledClaimLostError) {
            logger.warn("scheduled command no longer holds its claim; this run wrote nothing", {
              command: entry.command.type,
              dedupeKey: entry.dedupeKey,
            });
            continue;
          }
          logger.error("scheduled command could not be settled; its lease will lapse", {
            command: entry.command.type,
            dedupeKey: entry.dedupeKey,
            error: error instanceof RenewFailed ? error.cause : error,
          });
        }
      }
      for (const key of waits.keys()) {
        if (!due.some((entry) => entry.dedupeKey === key)) waits.delete(key);
      }
      await purgeExpiredKeys(claimedAt);
      const forgotten = (await retention?.sweep(claimedAt)) ?? 0;
      const rewrapped = (await rotation?.sweep(claimedAt)) ?? 0;
      const forgottenAgain = (await reconciliation?.sweep(claimedAt)) ?? 0;
      // A forgetting the ledger holds and the database does not: the database went back, though
      // the generation did not show it, as for a copy taken just before a forget.
      if (forgottenAgain > 0 && restores !== undefined && (restored ?? null) === null) {
        await restart((await restores.declare()).first, true);
      }
      const purged = (await letterRetention?.sweep(claimedAt)) ?? 0;
      const backfilled = (await backfill?.sweep(claimedAt)) ?? 0;
      if (unreadable !== undefined) throw unreadable.error;
      const done = due.length + forgotten + rewrapped + forgottenAgain + purged + backfilled;
      worked = done > 0;
      return done;
    });

  const schedule = (): void => {
    if (!running) return;
    cancelWait = clock.after(config.runtime.dispatcher.pollIntervalMs, async () => {
      await runOnce().catch((error: unknown) =>
        logger.error("scheduled command worker failed", { error }),
      );
      schedule();
    });
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      schedule();
    },
    stop: async () => {
      running = false;
      cancelWait?.();
      await mutex.drain();
      await Promise.all([
        backfill?.release(),
        retention?.release(),
        rotation?.release(),
        letterRetention?.release(),
      ]);
    },
    runOnce,
    leaseMs,
    waitingDeadlines: () => waits.size,
    restored: (first, { reconciled } = {}) => mutex.run(() => restart(first, reconciled)),
  };
};
