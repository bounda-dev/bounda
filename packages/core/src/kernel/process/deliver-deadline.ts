import type { DeadLetterErrorType } from "../../adapter/ports/dead-letter-store.ts";
import type { ResolvedConfig, ResolvedRetryConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import { errorDetails } from "../shared/retry.ts";
import type { ProcessesRuntime } from "./build-processes.ts";
import type { DeadlineStep } from "./deadline-step.ts";
import { type ProcessDeadlinePayload, reachedKey } from "./deadlines.ts";
import { deadlineSubject, type ProcessFailures } from "./failures.ts";
import type { ProcessInstances } from "./instances.ts";
import { instanceContext, lifecycleEntries, type ProcessInstance } from "./lifecycle.ts";
import { type DeadlineSchedule, pendingDeadline } from "./schedule.ts";

export type DeadlineTarget = Pick<ProcessDeadlinePayload, "process" | "aggregateId">;

export interface HandleDeadlineArgs {
  readonly payload: DeadlineTarget;
  readonly context: CausationContext;
}

export interface FailDeadlineArgs {
  readonly payload: DeadlineTarget;
  readonly error: unknown;
  readonly attempts: number;
  readonly errorType: DeadLetterErrorType;
}

/**
 * What the scheduled-command worker asks of processes about the deadline entries it runs.
 */
export interface ProcessDeadlines {
  /**
   * Runs the earliest due deadline, if any, then schedules the next one.
   */
  handleDeadline(args: HandleDeadlineArgs): Promise<void>;
  /**
   * How a failed deadline of the process is retried: as its event handlers are.
   */
  retryOf(process: string): ResolvedRetryConfig;
  /**
   * Whether a deadline failed because another write to its instance's stream got there first:
   * worth running again at once, without counting an attempt. A conflict on any other stream,
   * such as one a command of the handler met, is an ordinary failure.
   */
  lostRace(payload: DeadlineTarget, error: unknown): boolean;
  /**
   * Fails the process only when a deadline handler threw `error`. Either way the entry is written
   * again, since the worker has dropped it.
   */
  failDeadline(args: FailDeadlineArgs): Promise<void>;
}

export interface CreateDeadlineDeliveryArgs {
  readonly processes: ProcessesRuntime;
  readonly instances: ProcessInstances;
  readonly failures: ProcessFailures;
  readonly schedule: DeadlineSchedule;
  readonly deadlineStep: DeadlineStep;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateDeadlineDeliveryFunction {
  (args: CreateDeadlineDeliveryArgs): ProcessDeadlines;
}

export const createDeadlineDelivery: CreateDeadlineDeliveryFunction = ({
  processes,
  instances,
  failures,
  schedule,
  deadlineStep,
  config,
  clock,
  logger,
}) => {
  const handleDeadline = async ({ payload, context }: HandleDeadlineArgs): Promise<void> => {
    const process = processes.byName[payload.process];
    if (process === undefined) {
      await schedule.cancel(payload.process, payload.aggregateId);
      return;
    }
    const instance = await instances.load(process, payload.aggregateId);
    const due = pendingDeadline(process, instance);
    if (instance.status === "failed") {
      await failures.healFailure(process, instance);
    } else if (
      instance.status === "started" &&
      due !== null &&
      Date.parse(due.at) <= clock.now().getTime()
    ) {
      await deadlineStep.attempt({
        process,
        instanceId: payload.aggregateId,
        instance,
        due,
        context,
      });
    }
    await schedule.reconcile(process, payload.aggregateId);
  };

  const failDeadline = async ({
    payload,
    error,
    attempts,
    errorType,
  }: FailDeadlineArgs): Promise<void> => {
    const process = processes.byName[payload.process];
    if (process === undefined) {
      await schedule.cancel(payload.process, payload.aggregateId);
      return;
    }
    const failed = deadlineStep.thrownBy(error);
    const givesUp = (instance: ProcessInstance): boolean =>
      failed !== undefined &&
      instance.status === "started" &&
      !instance.reached.has(reachedKey(failed));
    let instance = await instances.load(process, payload.aggregateId);
    if (failed === undefined || !givesUp(instance)) {
      logger.warn("process deadline gave up without failing the process", {
        process: process.name,
        aggregateId: payload.aggregateId,
        status: instance.status,
        thrownBy: failed?.field ?? null,
        error: errorDetails(error).message,
      });
      await schedule.reconcile(process, payload.aggregateId);
      return;
    }
    const letter = failures.letterOf(
      process,
      deadlineSubject(process, payload.aggregateId, failed.field),
      error,
      attempts,
      errorType,
    );
    for (;;) {
      try {
        await instances.append(process, payload.aggregateId, instance, [
          lifecycleEntries.failed(
            { deadline: failed.field, at: failed.at },
            letter,
            instanceContext(process, payload.aggregateId, instance),
          ),
        ]);
        await failures.file(process, letter, error);
        break;
      } catch (appendError) {
        if (!instances.lostRace(process, payload.aggregateId, appendError)) throw appendError;
        instance = await instances.load(process, payload.aggregateId);
        if (!givesUp(instance)) break;
      }
    }
    await schedule.reconcile(process, payload.aggregateId);
  };

  return {
    handleDeadline,
    failDeadline,
    lostRace: (payload, error) => {
      const process = processes.byName[payload.process];
      return process !== undefined && instances.lostRace(process, payload.aggregateId, error);
    },
    retryOf: (name) => {
      const process = processes.byName[name];
      return process === undefined
        ? config.runtime.processes.retry
        : config.forAggregate(process.aggregate).processes.retry;
    },
  };
};
