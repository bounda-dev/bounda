import type { StoragePorts } from "../../adapter/adapter.ts";
import type { ClaimedCommand, ScheduledCommand } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { type CommandPipeline, scheduledCommandId } from "../command/pipeline.ts";
import type { DelayedPolicies } from "../policy/delayed.ts";
import type { ProcessDeadlinePayload, ProcessRunner } from "../process/runner.ts";
import { PROCESS_DEADLINE_COMMAND, PROCESSES_SUBSCRIBER } from "../process/runner.ts";
import { createMutex } from "../shared/mutex.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "../shared/retry.ts";
import {
  appendSystemEvent,
  COMMAND_FAILED_EVENT,
  type CommandFailedPayload,
} from "../system-events.ts";
import { ATTRIBUTES, deadLettered, traced } from "../telemetry.ts";

export interface ScheduledCommandWorker {
  start(): void;
  stop(): Promise<void>;
  /**
   * Claims and runs every command that is due. Resolves to how many ran.
   */
  runOnce(): Promise<number>;
  /**
   * How long a claim this worker takes is held before another worker may take it over: twice the
   * longest handler timeout any aggregate is configured with, so no run outlives its claim.
   */
  readonly leaseMs: number;
  /**
   * How many process deadlines that came due this worker holds back until the process runner has
   * handled the events stored before them.
   */
  waitingDeadlines(): number;
}

export interface CreateScheduledCommandWorkerArgs {
  readonly storage: StoragePorts;
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly processes: ProcessRunner;
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
 * How many rounds a process deadline that came due waits for the process runner to handle the
 * events stored before it, before it runs anyway.
 */
export const DEADLINE_WAIT_ROUNDS = 10;

interface DeadlineWait {
  readonly head: number;
  readonly rounds: number;
}

type GiveUpReason = "terminal" | "retriable_exhausted";

/**
 * Executes scheduled work: user commands dispatched with `delay`, process deadlines and delayed
 * policy runs. Due entries are claimed with a lease so two workers never run the same one. Work
 * that fails for a transient reason is rescheduled with back-off; work that fails for good, or
 * exhausts its retries, is dropped from the schedule and dead-lettered. A dropped command is also
 * recorded as a `CommandFailed` system event on its aggregate's stream; a dropped policy run is
 * dead-lettered as the policy's, so a replay runs the policy again; a dropped deadline fails its
 * process.
 *
 * A process deadline waits, for at most `DEADLINE_WAIT_ROUNDS` rounds, until the process runner
 * has handled every event stored when the worker first claimed it, so an event that cancels the
 * deadline is seen first. The check is best effort: the commands a deadline sends are still
 * checked by the aggregates that receive them. A deadline that waits, or whose instance moved
 * while it ran, goes back to the schedule without counting an attempt. A deadline entry is never
 * removed here, whether it ran or gave up: the process runner writes what the instance needs
 * next, so the worker only lets go of its claim, and a crash in between leaves the entry to its
 * lease instead of losing it. An entry that cannot be settled is logged and left to its
 * lease, so it does not hold back the rest of the round.
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
  const leaseMs =
    Math.max(
      config.runtime.policies.timeoutMs,
      ...Object.values(config.runtime.overrides).map((override) => override.policies.timeoutMs),
    ) * 2;

  const waits = new Map<string, DeadlineWait>();

  const isDeadline = (entry: ScheduledCommand): boolean =>
    entry.command.type === PROCESS_DEADLINE_COMMAND;

  const deadlineOf = (entry: ScheduledCommand): ProcessDeadlinePayload =>
    entry.command.payload as ProcessDeadlinePayload;

  const recordFailure = async (
    entry: ScheduledCommand,
    error: unknown,
    attempts: number,
  ): Promise<void> => {
    const aggregateType = aggregates.commandsByType[entry.command.type]?.aggregate.name;
    if (aggregateType === undefined) return;
    await appendSystemEvent({
      eventStore: storage.eventStore,
      ids,
      clock,
      aggregateType,
      aggregateId: entry.command.aggregateId,
      type: COMMAND_FAILED_EVENT,
      payload: {
        commandType: entry.command.type,
        error: errorDetails(error).message,
        attempts,
      } satisfies CommandFailedPayload,
      context: entry.context,
    });
  };

  const giveUpPolicy = async (
    entry: ScheduledCommand,
    error: unknown,
    attempts: number,
    reason: GiveUpReason,
  ): Promise<void> => {
    const details = errorDetails(error);
    const payload = delayedPolicies.payloadOf(entry);
    const now = clock.now().toISOString();
    await storage.deadLetterStore.add({
      id: ids.next(),
      kind: "policy",
      subscriber: payload.policy,
      eventId: payload.eventId,
      eventType: payload.eventType,
      aggregateType: payload.aggregateType,
      aggregateId: entry.command.aggregateId,
      errorType: reason,
      errorMessage: details.message,
      ...(details.stack === undefined ? {} : { errorStack: details.stack }),
      attempts,
      firstFailedAt: now,
      lastFailedAt: now,
    });
    deadLettered({ kind: "policy", subscriber: payload.policy, errorType: reason });
    logger.warn("policy dead-lettered", {
      policy: payload.policy,
      eventId: payload.eventId,
      errorType: reason,
      attempts,
    });
  };

  const giveUp = async (
    entry: ClaimedCommand,
    error: unknown,
    attempts: number,
    reason: GiveUpReason,
  ): Promise<void> => {
    if (isDeadline(entry)) {
      await processes.failDeadline({
        payload: deadlineOf(entry),
        error,
        attempts,
        errorType: reason,
      });
      await deferToItsTime(entry);
      return;
    }
    const details = errorDetails(error);
    await storage.scheduler.fail({ claim: entry, error: details.message });
    if (delayedPolicies.isDelayedPolicy(entry)) {
      await giveUpPolicy(entry, error, attempts, reason);
      return;
    }
    await recordFailure(entry, error, attempts);
    const now = clock.now().toISOString();
    await storage.deadLetterStore.add({
      id: ids.next(),
      kind: "command",
      subscriber: `scheduled:${entry.command.type}`,
      eventId: entry.dedupeKey,
      eventType: entry.command.type,
      aggregateType: aggregates.commandsByType[entry.command.type]?.aggregate.name ?? "",
      aggregateId: entry.command.aggregateId,
      errorType: reason,
      errorMessage: details.message,
      ...(details.stack === undefined ? {} : { errorStack: details.stack }),
      attempts,
      firstFailedAt: now,
      lastFailedAt: now,
      payload: entry.command.payload,
    });
    deadLettered({
      kind: "command",
      subscriber: `scheduled:${entry.command.type}`,
      errorType: reason,
    });
    logger.warn("scheduled command dropped", {
      command: entry.command.type,
      dedupeKey: entry.dedupeKey,
      reason,
      attempts,
    });
  };

  const run = (entry: ScheduledCommand): Promise<void> =>
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
          await delayedPolicies.run(entry);
        } else if (isDeadline(entry)) {
          await processes.handleDeadline({ payload: deadlineOf(entry), context: entry.context });
        } else {
          await pipeline.dispatch({
            type: entry.command.type,
            payload: entry.command.payload,
            context: entry.context,
            commandId: scheduledCommandId(entry.dedupeKey),
          });
        }
      },
    });

  const deferToItsTime = (entry: ClaimedCommand): Promise<void> =>
    storage.scheduler.defer({ claim: entry, executeAt: new Date(entry.executeAt) });

  const execute = async (entry: ClaimedCommand): Promise<void> => {
    try {
      await run(entry);
      if (isDeadline(entry)) await deferToItsTime(entry);
      else await storage.scheduler.complete(entry);
    } catch (error) {
      if (isDeadline(entry) && processes.lostRace(deadlineOf(entry), error)) {
        await deferToItsTime(entry);
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
      const due = await storage.scheduler.claimDue({
        now: clock.now(),
        limit: CLAIM_LIMIT,
        leaseMs,
      });
      const ready = await isDeadlineReady(due);
      for (const entry of due) {
        try {
          if (ready(entry)) await execute(entry);
          else await deferToItsTime(entry);
        } catch (error) {
          logger.error("scheduled command could not be settled; its lease will lapse", {
            command: entry.command.type,
            dedupeKey: entry.dedupeKey,
            ...errorDetails(error),
          });
        }
      }
      for (const key of waits.keys()) {
        if (!due.some((entry) => entry.dedupeKey === key)) waits.delete(key);
      }
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
