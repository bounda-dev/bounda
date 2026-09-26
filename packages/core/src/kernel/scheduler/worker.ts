import type { StoragePorts } from "../../adapter/adapter.ts";
import type { ScheduledCommand } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { type CommandPipeline, scheduledCommandId } from "../command/pipeline.ts";
import type { DelayedPolicies } from "../policy/delayed.ts";
import type { ProcessRunner, ProcessTimeoutPayload } from "../process/runner.ts";
import { PROCESS_TIMEOUT_COMMAND } from "../process/runner.ts";
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

type GiveUpReason = "terminal" | "retriable_exhausted";

/**
 * Executes scheduled work: user commands dispatched with `delay`, process timeouts and delayed
 * policy runs. Due entries are claimed with a lease so two workers never run the same one. Work
 * that fails for a transient reason is rescheduled with back-off; work that fails for good, or
 * exhausts its retries, is dropped from the schedule and dead-lettered. A dropped command is also
 * recorded as a `CommandFailed` system event on its aggregate's stream; a dropped policy run is
 * dead-lettered as the policy's, so a replay runs the policy again.
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

  const isTimeout = (entry: ScheduledCommand): boolean =>
    entry.command.type === PROCESS_TIMEOUT_COMMAND;

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
    entry: ScheduledCommand,
    error: unknown,
    attempts: number,
    reason: GiveUpReason,
  ): Promise<void> => {
    const details = errorDetails(error);
    await storage.scheduler.fail({ dedupeKey: entry.dedupeKey, error: details.message });
    if (delayedPolicies.isDelayedPolicy(entry)) {
      await giveUpPolicy(entry, error, attempts, reason);
      return;
    }
    if (!isTimeout(entry)) await recordFailure(entry, error, attempts);
    const now = clock.now().toISOString();
    await storage.deadLetterStore.add({
      id: ids.next(),
      kind: "command",
      subscriber: `scheduled:${entry.command.type}`,
      eventId: entry.dedupeKey,
      eventType: entry.command.type,
      aggregateType: isTimeout(entry)
        ? (entry.command.payload as ProcessTimeoutPayload).process
        : (aggregates.commandsByType[entry.command.type]?.aggregate.name ?? ""),
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
        } else if (isTimeout(entry)) {
          await processes.handleTimeout({
            payload: entry.command.payload as ProcessTimeoutPayload,
            context: entry.context,
          });
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

  const execute = async (entry: ScheduledCommand): Promise<void> => {
    try {
      await run(entry);
      await storage.scheduler.complete(entry.dedupeKey);
    } catch (error) {
      const attempts = entry.attempts + 1;
      const kind = classifyFailure(error);
      const retry = delayedPolicies.isDelayedPolicy(entry)
        ? delayedPolicies.retryOf(entry)
        : defaultRetry;
      if (kind === "retriable" && retry.strategy !== "none" && attempts < retry.maxAttempts) {
        const retryAt = new Date(
          clock.now().getTime() + retryDelayMs({ retry, attempt: attempts }),
        );
        await storage.scheduler.fail({
          dedupeKey: entry.dedupeKey,
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

  const runOnce = (): Promise<number> =>
    mutex.run(async () => {
      const due = await storage.scheduler.claimDue({
        now: clock.now(),
        limit: CLAIM_LIMIT,
        leaseMs,
      });
      for (const entry of due) await execute(entry);
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
  };
};
