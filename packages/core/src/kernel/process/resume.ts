import type { NewDeadLetter } from "../../adapter/ports/dead-letter-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import type { DeadlineStep } from "./deadline-step.ts";
import { type Deadline, reachedKey } from "./deadlines.ts";
import { blockedOn, deadlineSubject, drainFailureType, type ProcessFailures } from "./failures.ts";
import type { ProcessHandlers } from "./handlers.ts";
import {
  eventContext,
  instanceContext,
  type LifecycleEntry,
  lifecycleEntries,
  type ProcessInstance,
} from "./lifecycle.ts";
import { completesOn, handledEntries, handlerOf, letThrough } from "./routes.ts";
import { type DeadlineSchedule, pendingDeadline } from "./schedule.ts";
import type { ProcessUnits } from "./units.ts";

export interface ResumeParked {
  /**
   * Called once the failed step succeeded on replay. Drains the parked events in order, each
   * deadline that came due before one of them running first, then writes `ProcessResumed`. Each
   * step is one unit of work. Stops as soon as the instance is no longer failed on `letter`.
   */
  resumeParked(
    process: ProcessRuntime,
    instanceId: string,
    letter: string | undefined,
  ): Promise<void>;
}

export interface CreateResumeParkedArgs {
  readonly units: ProcessUnits;
  readonly failures: ProcessFailures;
  readonly handlers: ProcessHandlers;
  readonly deadlineStep: DeadlineStep;
  readonly schedule: DeadlineSchedule;
  readonly logger: Logger;
}

export interface CreateResumeParkedFunction {
  (args: CreateResumeParkedArgs): ResumeParked;
}

// A drained step's handler failed: the step is written as the instance's new failure instead.
class StepFailed extends Error {
  constructor(cause: unknown) {
    super("step failed", { cause });
  }
}

// What a drained step's handler threw; any other error, the commit's, is thrown on as it is.
const failedStep = (error: unknown): unknown => {
  if (!(error instanceof StepFailed)) throw error;
  return error.cause;
};

export const createResumeParked: CreateResumeParkedFunction = ({
  units,
  failures,
  handlers,
  deadlineStep,
  schedule,
  logger,
}) => {
  const { load, parkedEvent } = units.live;

  // Whether the drain can go on: the instance is still failed, on `letter` when named.
  const draining = (instance: ProcessInstance, letter: string | undefined): boolean =>
    instance.status === "failed" && blockedOn(instance, letter);

  // Writes the failure of a drained step, unless it was written already or the instance moved
  // past the step; resolves to whether the drain goes on.
  const recordFailure = async (
    process: ProcessRuntime,
    instanceId: string,
    stepOf: (instance: ProcessInstance) => "recorded" | "moved" | undefined,
    entryOf: (instance: ProcessInstance, letter: NewDeadLetter) => LifecycleEntry,
    letterOf: (instance: ProcessInstance) => NewDeadLetter,
    error: unknown,
  ): Promise<boolean> => {
    let outcome: "recorded" | "moved" | undefined;
    let filed: NewDeadLetter | undefined;
    await units.commit(async (unit, within) => {
      const current = await within.load(process, instanceId);
      filed = undefined;
      outcome = stepOf(current);
      if (outcome !== undefined) return;
      const letter = letterOf(current);
      await within.append(process, instanceId, current, [entryOf(current, letter)]);
      await failures.file(unit.deadLetterStore, process, letter, error);
      await schedule.stage(unit, process, instanceId);
      filed = letter;
    });
    if (filed !== undefined) failures.filed(process, filed);
    return outcome === "moved";
  };

  const handleParked = async (
    process: ProcessRuntime,
    instanceId: string,
    event: StoredEvent,
    letter: string | undefined,
  ): Promise<boolean> => {
    try {
      await units.commit(async (unit, within) => {
        const instance = await within.load(process, instanceId);
        if (!draining(instance, letter) || instance.parked[0]?.eventId !== event.id) return;
        const state = await stateAfter(unit, process, instanceId, instance, event);
        await within.append(process, instanceId, instance, handledEntries(process, event, state));
        await schedule.stage(unit, process, instanceId);
      });
      return true;
    } catch (error) {
      const cause = failedStep(error);
      return recordFailure(
        process,
        instanceId,
        (current) => {
          if (current.failure?.eventId === event.id) return "recorded";
          if (current.status !== "failed" || current.parked[0]?.eventId !== event.id) {
            return "moved";
          }
          return undefined;
        },
        (_current, filed) =>
          lifecycleEntries.failed({ eventId: event.id }, filed, eventContext(event)),
        () => failures.letterOf(process, event, cause, 1, drainFailureType(cause)),
        cause,
      );
    }
  };

  const stateAfter = async (
    unit: UnitOfWork,
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    event: StoredEvent,
  ): Promise<object> => {
    if (handlerOf(process, event) === undefined) {
      if (!completesOn(process, event)) letThrough(process, instanceId, event, logger);
      return instance.state;
    }
    try {
      return await handlers.runEventHandler({
        process,
        event,
        instanceId,
        instance,
        attempt: 1,
        within: unit,
      });
    } catch (error) {
      throw new StepFailed(error);
    }
  };

  const drainDeadline = async (
    process: ProcessRuntime,
    instanceId: string,
    due: Deadline,
    letter: string | undefined,
  ): Promise<boolean> => {
    try {
      await units.commit(async (unit, within) => {
        const instance = await within.load(process, instanceId);
        if (!draining(instance, letter) || instance.reached.has(reachedKey(due))) return;
        try {
          await deadlineStep.run({
            unit,
            process,
            instanceId,
            instance,
            due,
            context: instanceContext(process, instanceId, instance),
          });
        } catch (error) {
          throw new StepFailed(error);
        }
        await schedule.stage(unit, process, instanceId);
      });
      return true;
    } catch (error) {
      const cause = failedStep(error);
      return recordFailure(
        process,
        instanceId,
        (current) => {
          const recorded = current.failure?.deadline;
          if (recorded !== undefined && reachedKey(recorded) === reachedKey(due)) return "recorded";
          if (current.status !== "failed" || current.reached.has(reachedKey(due))) return "moved";
          return undefined;
        },
        (current, filed) =>
          lifecycleEntries.failed(
            { deadline: due.field, at: due.at },
            filed,
            instanceContext(process, instanceId, current),
          ),
        () =>
          failures.letterOf(
            process,
            deadlineSubject(process, instanceId, due.field),
            cause,
            1,
            drainFailureType(cause),
          ),
        cause,
      );
    }
  };

  const resume = async (
    process: ProcessRuntime,
    instanceId: string,
    letter: string | undefined,
  ): Promise<boolean> => {
    let resumed = false;
    await units.commit(async (unit, within) => {
      const instance = await within.load(process, instanceId);
      resumed = false;
      if (!draining(instance, letter) || instance.parked.length > 0) return;
      await within.append(process, instanceId, instance, [
        lifecycleEntries.resumed(instanceContext(process, instanceId, instance)),
      ]);
      await schedule.stage(unit, process, instanceId);
      resumed = true;
    });
    if (resumed) logger.info("process resumed", { process: process.name, aggregateId: instanceId });
    return resumed;
  };

  const resumeParked = async (
    process: ProcessRuntime,
    instanceId: string,
    letter: string | undefined,
  ): Promise<void> => {
    for (;;) {
      const instance = await load(process, instanceId);
      if (!draining(instance, letter)) return;
      const [next] = instance.parked;
      const event = next === undefined ? undefined : await parkedEvent(next);
      const due = pendingDeadline(process, instance);
      if (
        event !== undefined &&
        due !== null &&
        Date.parse(due.at) <= Date.parse(event.timestamp)
      ) {
        if (!(await drainDeadline(process, instanceId, due, letter))) return;
        continue;
      }
      if (event === undefined) {
        if (await resume(process, instanceId, letter)) return;
        continue;
      }
      if (!(await handleParked(process, instanceId, event, letter))) return;
    }
  };

  return { resumeParked };
};
