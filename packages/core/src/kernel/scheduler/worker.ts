import type { StoragePorts } from "../../adapter/adapter.ts";
import type { ScheduledCommand } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import type { ProcessRunner, ProcessTimeoutPayload } from "../process/runner.ts";
import { PROCESS_TIMEOUT_COMMAND } from "../process/runner.ts";
import { createMutex } from "../shared/mutex.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "../shared/retry.ts";
import {
  appendSystemEvent,
  COMMAND_FAILED_EVENT,
  type CommandFailedPayload,
} from "../system-events.ts";

export interface ScheduledCommandWorker {
  start(): void;
  stop(): Promise<void>;
  /**
   * Claims and runs every command that is due. Resolves to how many ran.
   */
  runOnce(): Promise<number>;
}

export interface CreateScheduledCommandWorkerArgs {
  readonly storage: StoragePorts;
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly processes: ProcessRunner;
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
 * Executes scheduled work: user commands dispatched with `delay` and process timeouts. Due entries
 * are claimed with a lease so two workers never run the same one. A command that fails for a
 * transient reason is rescheduled with back-off; one that fails for good, or exhausts its
 * retries, is dropped from the schedule, recorded as a `CommandFailed` system event on its
 * aggregate's stream and dead-lettered.
 */
export const createScheduledCommandWorker: CreateScheduledCommandWorkerFunction = ({
  storage,
  aggregates,
  pipeline,
  processes,
  config,
  ids,
  clock,
  logger,
}) => {
  const mutex = createMutex();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const retry = config.runtime.policies.retry;
  const leaseMs = config.runtime.policies.timeoutMs * 2;

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

  const giveUp = async (
    entry: ScheduledCommand,
    error: unknown,
    attempts: number,
    reason: GiveUpReason,
  ): Promise<void> => {
    const details = errorDetails(error);
    await storage.scheduler.fail({ dedupeKey: entry.dedupeKey, error: details.message });
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
    logger.warn("scheduled command dropped", {
      command: entry.command.type,
      dedupeKey: entry.dedupeKey,
      reason,
      attempts,
    });
  };

  const execute = async (entry: ScheduledCommand): Promise<void> => {
    try {
      if (isTimeout(entry)) {
        await processes.handleTimeout({
          payload: entry.command.payload as ProcessTimeoutPayload,
          context: entry.context,
        });
      } else {
        await pipeline.dispatch({
          type: entry.command.type,
          payload: entry.command.payload,
          context: entry.context,
        });
      }
      await storage.scheduler.complete(entry.dedupeKey);
    } catch (error) {
      const attempts = entry.attempts + 1;
      const kind = classifyFailure(error);
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
    timer = setTimeout(async () => {
      await runOnce().catch((error: unknown) =>
        logger.error("scheduled command worker failed", errorDetails(error)),
      );
      schedule();
    }, config.runtime.dispatcher.pollIntervalMs);
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      schedule();
    },
    stop: async () => {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      await mutex.drain();
    },
    runOnce,
  };
};
