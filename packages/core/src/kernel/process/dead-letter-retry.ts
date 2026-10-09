import type { DeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import {
  DeadLetterNotRetriableError,
  DeadLetterSettledError,
  NotFoundError,
} from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { ProcessesRuntime, ProcessRuntime } from "./build-processes.ts";
import type { DeadlineStep } from "./deadline-step.ts";
import { PROCESS_DEADLINE_COMMAND, reachedKey } from "./deadlines.ts";
import type { DeadlineTarget } from "./deliver-deadline.ts";
import { blockedOn } from "./failures.ts";
import type { ProcessHandlers } from "./handlers.ts";
import { lifecycleEntries, type ProcessInstance } from "./lifecycle.ts";
import type { ResumeParked } from "./resume.ts";
import { completesOn, handledEntries, handlerOf, letThrough, pendingFollowUp } from "./routes.ts";
import type { DeadlineSchedule } from "./schedule.ts";
import type { ProcessUnits } from "./units.ts";

interface RetryArgs {
  /**
   * Identifies this retry, so the handler's `idempotencyKey` differs from the failed run's.
   */
  readonly retryId: string;
  /**
   * The id of the dead letter being retried: the retry goes on only while it is the failure its
   * instance is blocked on or, for a follow-up of a timed-out instance, while it is still failed.
   */
  readonly letter?: string | undefined;
}

export interface RetryProcessArgs extends RetryArgs {
  /**
   * The process name as a dead letter records it, e.g. `order.orderPayment`.
   */
  readonly process: string;
  readonly event: StoredEvent;
}

export interface RetryDeadlineArgs extends RetryArgs {
  readonly payload: DeadlineTarget;
  readonly context: CausationContext;
}

/**
 * What the dead letters ask of processes about the letters they file.
 */
export interface ProcessDeadLetters {
  /**
   * Ignores the inbox ledger. The retried step is one unit of work; a failed process then drains
   * its parked events in order before it resumes, one unit each; one that fails again becomes the
   * new failure, and the rest stay parked. A follow-up of a timed-out instance has nothing to
   * drain, so its retry marks `letter` retried in its own unit and resolves to `true`; any other
   * resolves to `false`, leaving the letter to the caller.
   */
  retry(args: RetryProcessArgs): Promise<boolean>;
  /**
   * Runs again the deadline a process failed on, with a new `idempotencyKey`, then resumes the
   * instance as `retry` does.
   */
  retryDeadline(args: RetryDeadlineArgs): Promise<void>;
  /**
   * How many events wait behind a process dead letter: those parked on its instance while the
   * failure it records keeps the instance failed. `0` for any other letter.
   */
  parkedBehind(letter: DeadLetter): Promise<number>;
  /**
   * After a retry of a process dead letter: how many steps of its instance still wait because
   * the process failed again, the one it failed on included, whether an event or a deadline. `0`
   * once it resumed.
   */
  stillParked(letter: DeadLetter): Promise<number>;
}

export interface CreateProcessRetryArgs {
  readonly processes: ProcessesRuntime;
  readonly units: ProcessUnits;
  readonly handlers: ProcessHandlers;
  readonly schedule: DeadlineSchedule;
  readonly deadlineStep: DeadlineStep;
  readonly resume: ResumeParked;
  readonly logger: Logger;
}

export interface CreateProcessRetryFunction {
  (args: CreateProcessRetryArgs): ProcessDeadLetters;
}

const failedOnAnotherStep = (
  process: ProcessRuntime,
  instanceId: string,
): DeadLetterNotRetriableError =>
  new DeadLetterNotRetriableError(
    `Process "${process.name}" is failed on another step for ${instanceId}; retry the dead letter of that failure first`,
  );

const registered = (processes: ProcessesRuntime, name: string): ProcessRuntime => {
  const process = processes.byName[name];
  if (process === undefined) {
    throw new DeadLetterNotRetriableError(`Process "${name}" is no longer in the registry`);
  }
  return process;
};

export const createProcessRetry: CreateProcessRetryFunction = ({
  processes,
  units,
  handlers,
  schedule,
  deadlineStep,
  resume,
  logger,
}) => {
  const { load } = units.live;

  const retry = async ({
    process: name,
    event,
    retryId,
    letter,
  }: RetryProcessArgs): Promise<boolean> => {
    const process = registered(processes, name);
    const instanceId = process.instanceOf(event);
    const instance = instanceId === null ? null : await load(process, instanceId);
    const failedHere =
      instance?.status === "failed" &&
      instance.failure?.eventId === event.id &&
      blockedOn(instance, letter);
    const handler = handlerOf(process, event);
    const followUp = instance !== null && pendingFollowUp(instance, event);
    if (handler === undefined && !failedHere && !followUp) {
      throw new DeadLetterNotRetriableError(`Process "${name}" no longer handles ${event.type}`);
    }
    if (instanceId === null || instance === null || !instance.exists) {
      throw new NotFoundError(
        `Process "${name}" has no instance for ${event.aggregateType}:${event.aggregateId}`,
      );
    }
    if (instance.status === "failed" && !failedHere) throw failedOnAnotherStep(process, instanceId);
    let settled = false;
    await units.commit(async (unit, within) => {
      settled = false;
      const current = await within.load(process, instanceId);
      const pending = pendingFollowUp(current, event);
      if (current.status !== "started" && current.status !== "failed" && !pending) return;
      if (pending && letter !== undefined) {
        // On every run, a rerun after a conflict included: a letter settled meanwhile runs nothing.
        if ((await unit.deadLetterStore.get(letter))?.status !== "failed") {
          throw new DeadLetterSettledError({ id: letter });
        }
        await unit.deadLetterStore.updateStatus(letter, "retried");
        settled = true;
      }
      if (current.handledEventIds.has(event.id)) {
        if (!completesOn(process, event)) return;
        await within.append(process, instanceId, current, [lifecycleEntries.completed(event)]);
      } else {
        let state = current.state;
        if (handler === undefined) {
          letThrough(process, instanceId, event, logger);
        } else {
          state = await handlers.runEventHandler({
            process,
            event,
            instanceId,
            instance: current,
            attempt: 1,
            retryId,
            within: unit,
          });
        }
        await within.append(
          process,
          instanceId,
          current,
          handledEntries(process, current, event, state),
        );
      }
      await schedule.stage(unit, process, instanceId);
    });
    if (!settled) await resume.resumeParked(process, instanceId, letter);
    logger.info("process handler retried", { process: process.name, eventId: event.id });
    return settled;
  };

  const retryDeadline = async ({
    payload,
    context,
    retryId,
    letter,
  }: RetryDeadlineArgs): Promise<void> => {
    const process = registered(processes, payload.process);
    const instance = await load(process, payload.aggregateId);
    const failed = instance.failure?.deadline;
    if (instance.status === "failed" && !blockedOn(instance, letter)) {
      throw failedOnAnotherStep(process, payload.aggregateId);
    }
    if (instance.status !== "failed" || failed === undefined) {
      throw new NotFoundError(
        `Process "${process.name}" has no failed deadline for ${payload.aggregateId}`,
      );
    }
    await units.commit(async (unit, within) => {
      const current = await within.load(process, payload.aggregateId);
      // A concurrent retry of the same letter may have run the deadline already: the timeout
      // then ended the instance, which `reached` does not record.
      if (
        current.status !== "failed" ||
        !blockedOn(current, letter) ||
        current.reached.has(reachedKey(failed))
      ) {
        return;
      }
      await deadlineStep.attempt({
        unit,
        process,
        instanceId: payload.aggregateId,
        instance: current,
        due: failed,
        context: { ...context, correlationId: current.correlationId ?? context.correlationId },
        retryId,
      });
      await schedule.stage(unit, process, payload.aggregateId);
    });
    await resume.resumeParked(process, payload.aggregateId, letter);
  };

  const instanceOfLetter = async (letter: DeadLetter): Promise<ProcessInstance | null> => {
    const process = processes.byName[letter.handler];
    if (letter.kind !== "process" || process === undefined) return null;
    const instanceId =
      letter.eventType === PROCESS_DEADLINE_COMMAND
        ? letter.aggregateId
        : await units.live
            .parkedEvent({
              eventId: letter.eventId,
              eventType: letter.eventType,
              aggregateType: letter.aggregateType,
              aggregateId: letter.aggregateId,
            })
            .then((event) => process.instanceOf(event))
            .catch(() => null);
    return instanceId === null ? null : load(process, instanceId);
  };

  return {
    retry,
    retryDeadline,
    parkedBehind: async (letter) => {
      const instance = letter.status === "failed" ? await instanceOfLetter(letter) : null;
      const failure = instance?.failure;
      return instance?.status === "failed" && failure?.letterId === letter.id
        ? instance.parked.filter((parked) => parked.eventId !== failure.eventId).length
        : 0;
    },
    stillParked: async (letter) => {
      const instance = await instanceOfLetter(letter);
      return instance?.status === "failed"
        ? instance.parked.length + (instance.failure?.deadline === undefined ? 0 : 1)
        : 0;
    },
  };
};
