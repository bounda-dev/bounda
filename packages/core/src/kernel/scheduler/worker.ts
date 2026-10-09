import type { StoragePorts } from "../../adapter/adapter.ts";
import type { DeadLetterErrorType, NewDeadLetter } from "../../adapter/ports/dead-letter-store.ts";
import type { ClaimedCommand, ScheduledCommand } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ScheduledClaimLostError } from "../../contracts/errors.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { type CommandPipeline, scheduledCommandId } from "../command/pipeline.ts";
import type { DelayedPolicies } from "../policy/delayed.ts";
import { PROCESS_DEADLINE_COMMAND, type ProcessDeadlinePayload } from "../process/deadlines.ts";
import type { ProcessDeadlines } from "../process/deliver-deadline.ts";
import { PROCESSES_SUBSCRIBER } from "../process/runner.ts";
import { createMutex } from "../shared/mutex.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "../shared/retry.ts";
import {
  appendSystemEvent,
  SCHEDULED_COMMAND_FAILED_EVENT,
  type ScheduledCommandFailedPayload,
} from "../system-events.ts";
import { ATTRIBUTES, deadLettered, traced } from "../telemetry.ts";
import { commitWork, type UnitOfWork } from "../unit-of-work/unit-of-work.ts";

export interface ScheduledCommandWorker {
  start(): void;
  stop(): Promise<void>;
  /**
   * Resolves to how many entries it claimed, those it deferred included.
   */
  runOnce(): Promise<number>;
  /**
   * Outlasts the slowest handler timeout. A run renews its claim before each rerun after a
   * conflict, so the lease covers one run, not a batch; the store has no time limit, so a run can
   * still outlive it.
   */
  readonly leaseMs: number;
  waitingDeadlines(): number;
}

export interface CreateScheduledCommandWorkerArgs {
  readonly storage: StoragePorts;
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly processes: ProcessDeadlines;
  readonly delayedPolicies: DelayedPolicies;
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
 * A renewal before a rerun that failed in the store: the store's failure, not the run's, so it is
 * neither retried nor dead-lettered as one.
 */
class RenewFailed extends Error {
  constructor(cause: unknown) {
    super(undefined, { cause });
  }
}

/**
 * Rounds a due deadline waits for the process runner to catch up before it runs anyway.
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
 * leaves the entry to its lease instead of losing it.
 */
export const createScheduledCommandWorker: CreateScheduledCommandWorkerFunction = ({
  storage,
  aggregates,
  pipeline,
  processes,
  delayedPolicies,
  config,
  ids,
  clock,
  logger,
}) => {
  const mutex = createMutex();
  let cancelWait: (() => void) | undefined;
  let running = false;
  const defaultRetry = config.runtime.policies.retry;
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

  const isDeadline = (entry: ScheduledCommand): boolean =>
    entry.command.type === PROCESS_DEADLINE_COMMAND;

  const deadlineOf = (entry: ScheduledCommand): ProcessDeadlinePayload =>
    entry.command.payload as ProcessDeadlinePayload;

  const settled = (
    entry: ClaimedCommand,
    work: (unit: UnitOfWork) => Promise<void>,
  ): Promise<void> =>
    commitWork({
      storage,
      concurrencyRetries: config.runtime.commands.concurrencyRetries,
      work,
      beforeRerun: async () => {
        try {
          await storage.scheduler.renew({ claim: entry, now: clock.now() });
        } catch (error) {
          throw error instanceof ScheduledClaimLostError ? error : new RenewFailed(error);
        }
      },
    });

  const recordFailure = async (
    unit: UnitOfWork,
    entry: ScheduledCommand,
    error: unknown,
    attempts: number,
  ): Promise<void> => {
    const aggregateType = aggregates.commandsByType[entry.command.type]?.aggregate.name;
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
        error: errorDetails(error).message,
        attempts,
      } satisfies ScheduledCommandFailedPayload,
      context: entry.context,
    });
  };

  const letterOf = (
    entry: ScheduledCommand,
    error: unknown,
    attempts: number,
    reason: DeadLetterErrorType,
  ): NewDeadLetter => {
    const details = errorDetails(error);
    const now = clock.now().toISOString();
    const stack = details.stack === undefined ? {} : { errorStack: details.stack };
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
        errorType: reason,
        errorMessage: details.message,
        ...stack,
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
      aggregateType: aggregates.commandsByType[entry.command.type]?.aggregate.name ?? "",
      aggregateId: entry.command.aggregateId,
      errorType: reason,
      errorMessage: details.message,
      ...stack,
      attempts,
      firstFailedAt: now,
      lastFailedAt: now,
      payload: entry.command.payload,
    };
  };

  const dropped = (entry: ScheduledCommand, letter: NewDeadLetter): void => {
    deadLettered(letter);
    if (letter.kind === "policy") {
      logger.warn("policy dead-lettered", {
        policy: letter.handler,
        eventId: letter.eventId,
        errorType: letter.errorType,
        attempts: letter.attempts,
      });
      return;
    }
    logger.warn("scheduled command dropped", {
      command: entry.command.type,
      dedupeKey: entry.dedupeKey,
      reason: letter.errorType,
      attempts: letter.attempts,
    });
  };

  const giveUp = async (
    entry: ClaimedCommand,
    error: unknown,
    attempts: number,
    reason: DeadLetterErrorType,
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
    const letter = letterOf(entry, error, attempts, reason);
    await settled(entry, async (unit) => {
      if (!delayedPolicies.isDelayedPolicy(entry))
        await recordFailure(unit, entry, error, attempts);
      await unit.deadLetterStore.add(letter);
      await unit.scheduler.fail({ claim: entry, error: letter.errorMessage });
    });
    dropped(entry, letter);
  };

  const run = (entry: ScheduledCommand, unit: UnitOfWork): Promise<void> =>
    traced({
      name: `bounda.scheduled ${entry.command.type}`,
      attributes: {
        [ATTRIBUTES.commandType]: entry.command.type,
        [ATTRIBUTES.aggregateId]: entry.command.aggregateId,
        [ATTRIBUTES.correlationId]: entry.context.correlationId,
        [ATTRIBUTES.attempt]: entry.attempts + 1,
      },
      run: async () => {
        if (delayedPolicies.isDelayedPolicy(entry)) {
          await delayedPolicies.run(entry, unit);
        } else if (isDeadline(entry)) {
          await processes.handleDeadline({
            payload: deadlineOf(entry),
            within: unit,
          });
        } else {
          await pipeline.dispatchUnattended({
            type: entry.command.type,
            payload: entry.command.payload,
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
    try {
      // Settled before the run stages anything, so a run that schedules or cancels its own key
      // does not make the claim look lost.
      await settled(entry, async (unit) => {
        if (isDeadline(entry)) await deferToItsTime(entry, unit);
        else await unit.scheduler.complete(entry);
        await run(entry, unit);
      });
    } catch (error) {
      if (error instanceof ScheduledClaimLostError || error instanceof RenewFailed) throw error;
      if (isDeadline(entry) && processes.lostRace(deadlineOf(entry), error)) {
        await deferToItsTime(entry, storage);
        return;
      }
      const attempts = entry.attempts + 1;
      const kind = classifyFailure(error);
      const retry = delayedPolicies.isDelayedPolicy(entry)
        ? delayedPolicies.retryOf(entry)
        : isDeadline(entry)
          ? processes.retryOf(deadlineOf(entry).process)
          : defaultRetry;
      if (kind === "retriable" && retry.strategy !== "none" && attempts < retry.maxAttempts) {
        const retryAt = new Date(
          clock.now().getTime() + retryDelayMs({ retry, attempt: attempts }),
        );
        await storage.scheduler.fail({
          claim: entry,
          error: errorDetails(error).message,
          retryAt,
        });
        logger.warn("scheduled command failed; rescheduled", {
          command: entry.command.type,
          attempts,
          retryAt: retryAt.toISOString(),
        });
        return;
      }
      await giveUp(
        entry,
        error,
        attempts,
        kind === "terminal" ? "terminal" : "retriable_exhausted",
      );
    }
  };

  const isDeadlineReady = async (
    due: readonly ClaimedCommand[],
  ): Promise<(entry: ClaimedCommand) => boolean> => {
    if (!due.some(isDeadline)) return () => true;
    const [head, position] = await Promise.all([
      storage.eventStore.lastPosition(),
      storage.checkpointStore.get(PROCESSES_SUBSCRIBER),
    ]);
    return (entry) => {
      if (!isDeadline(entry)) return true;
      const wait = waits.get(entry.dedupeKey) ?? { head, rounds: 0 };
      if (position >= wait.head || wait.rounds >= DEADLINE_WAIT_ROUNDS) {
        waits.delete(entry.dedupeKey);
        return true;
      }
      waits.set(entry.dedupeKey, { head: wait.head, rounds: wait.rounds + 1 });
      return false;
    };
  };

  const runOnce = (): Promise<number> =>
    mutex.run(async () => {
      const claimedAt = clock.now();
      const due = await storage.scheduler.claimDue({ now: claimedAt, limit: CLAIM_LIMIT, leaseMs });
      // The batch is claimed already: an error escaping here would leave every entry to lapse, and
      // each would be charged an attempt it never made. Deadlines wait for the next round instead,
      // and the error ends this one once the rest has run.
      let unreadable: { readonly error: unknown } | undefined;
      const ready = await isDeadlineReady(due).catch((error: unknown) => {
        unreadable = { error };
        return (entry: ClaimedCommand) => !isDeadline(entry);
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
            ...errorDetails(error instanceof RenewFailed ? error.cause : error),
          });
        }
      }
      for (const key of waits.keys()) {
        if (!due.some((entry) => entry.dedupeKey === key)) waits.delete(key);
      }
      if (unreadable !== undefined) throw unreadable.error;
      return due.length;
    });

  const schedule = (): void => {
    if (!running) return;
    cancelWait = clock.after(config.runtime.dispatcher.pollIntervalMs, async () => {
      await runOnce().catch((error: unknown) =>
        logger.error("scheduled command worker failed", errorDetails(error)),
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
    },
    runOnce,
    leaseMs,
    waitingDeadlines: () => waits.size,
  };
};
