import type { DeadLetterErrorType, NewDeadLetter } from "../../adapter/ports/dead-letter-store.ts";
import type { ResolvedConfig, ResolvedRetryConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import { errorDetails } from "../shared/retry.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { ProcessesRuntime } from "./build-processes.ts";
import type { DeadlineStep } from "./deadline-step.ts";
import { type ProcessDeadlinePayload, reachedKey } from "./deadlines.ts";
import { deadlineSubject, type ProcessFailures } from "./failures.ts";
import { instanceContext, lifecycleEntries, type ProcessStatus } from "./lifecycle.ts";
import { type DeadlineSchedule, pendingDeadline } from "./schedule.ts";
import type { ProcessUnits } from "./units.ts";

export type DeadlineTarget = Pick<ProcessDeadlinePayload, "process" | "aggregateId">;

export interface HandleDeadlineArgs {
  readonly payload: DeadlineTarget;
  readonly context: CausationContext;
  /**
   * The unit of work to stage the step on, when the caller commits it, with what it settles of
   * the entry's claim. Without one the step commits on its own.
   */
  readonly within?: UnitOfWork | undefined;
}

export interface FailDeadlineArgs {
  readonly payload: DeadlineTarget;
  readonly error: unknown;
  readonly attempts: number;
  readonly errorType: DeadLetterErrorType;
  /**
   * Stages what settles the entry's claim, before anything else, so it commits with the failure
   * or nothing of the failure does.
   */
  readonly settle: (unit: UnitOfWork) => Promise<void>;
}

/**
 * What the scheduled-command worker asks of processes about the deadline entries it runs.
 */
export interface ProcessDeadlines {
  /**
   * Runs the earliest due deadline, if any, and writes the next entry with it, in one unit of
   * work: a commit that finds the instance moved runs the deadline again on the instance as it
   * now is.
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
   * Fails the process only when a deadline handler threw `error`, with `ProcessFailed`, the dead
   * letter and the entry written together. Either way the entry is written again, over what
   * `settle` left of it.
   */
  failDeadline(args: FailDeadlineArgs): Promise<void>;
}

export interface CreateDeadlineDeliveryArgs {
  readonly processes: ProcessesRuntime;
  readonly units: ProcessUnits;
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
  units,
  failures,
  schedule,
  deadlineStep,
  config,
  clock,
  logger,
}) => {
  const handleDeadline = async ({
    payload,
    context,
    within,
  }: HandleDeadlineArgs): Promise<void> => {
    const process = processes.byName[payload.process];
    if (process === undefined) {
      await schedule.cancel(payload.process, payload.aggregateId, within);
      return;
    }
    const step = async (unit: UnitOfWork): Promise<void> => {
      const instance = await units.over(unit).load(process, payload.aggregateId);
      const due = pendingDeadline(process, instance);
      if (
        instance.status === "started" &&
        due !== null &&
        Date.parse(due.at) <= clock.now().getTime()
      ) {
        await deadlineStep.attempt({
          unit,
          process,
          instanceId: payload.aggregateId,
          instance,
          due,
          context,
        });
      }
      await schedule.stage(unit, process, payload.aggregateId);
    };
    if (within !== undefined) {
      await step(within);
      return;
    }
    await units.commit(step);
  };

  const failDeadline = async ({
    payload,
    error,
    attempts,
    errorType,
    settle,
  }: FailDeadlineArgs): Promise<void> => {
    const process = processes.byName[payload.process];
    if (process === undefined) {
      await schedule.cancel(payload.process, payload.aggregateId);
      return;
    }
    const failed = deadlineStep.thrownBy(error);
    let letter: NewDeadLetter | undefined;
    let status: ProcessStatus | undefined;
    await units.commit(async (unit, within) => {
      await settle(unit);
      const instance = await within.load(process, payload.aggregateId);
      letter = undefined;
      status = instance.status;
      if (
        failed !== undefined &&
        instance.status === "started" &&
        !instance.reached.has(reachedKey(failed))
      ) {
        letter = failures.letterOf(
          process,
          deadlineSubject(process, payload.aggregateId, failed.field),
          error,
          attempts,
          errorType,
        );
        await within.append(process, payload.aggregateId, instance, [
          lifecycleEntries.failed(
            { deadline: failed.field, at: failed.at },
            letter,
            instanceContext(process, payload.aggregateId, instance),
          ),
        ]);
        await failures.file(unit.deadLetterStore, process, letter, error);
      }
      await schedule.stage(unit, process, payload.aggregateId);
    });
    if (letter === undefined) {
      logger.warn("process deadline gave up without failing the process", {
        process: process.name,
        aggregateId: payload.aggregateId,
        status,
        thrownBy: failed?.field ?? null,
        error: errorDetails(error).message,
      });
      return;
    }
    failures.filed(process, letter);
  };

  return {
    handleDeadline,
    failDeadline,
    lostRace: (payload, error) => {
      const process = processes.byName[payload.process];
      return process !== undefined && units.live.lostRace(process, payload.aggregateId, error);
    },
    retryOf: (name) => {
      const process = processes.byName[name];
      return process === undefined
        ? config.runtime.processes.retry
        : config.forAggregate(process.aggregate).processes.retry;
    },
  };
};
