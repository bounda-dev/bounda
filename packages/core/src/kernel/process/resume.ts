import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import type { DeadlineStep } from "./deadline-step.ts";
import { type Deadline, reachedKey } from "./deadlines.ts";
import { blockedOn, deadlineSubject, drainFailureType, type ProcessFailures } from "./failures.ts";
import type { HandlerRun, ProcessHandlers } from "./handlers.ts";
import type { ProcessInstances } from "./instances.ts";
import {
  eventContext,
  instanceContext,
  lifecycleEntries,
  type ProcessInstance,
} from "./lifecycle.ts";
import { completesOn, handledEntries, handlerOf, letThrough } from "./routes.ts";
import { pendingDeadline } from "./schedule.ts";

/**
 * What lifts a failure once its step succeeded on replay: the steps parked behind it.
 */
export interface ResumeParked {
  /**
   * Handles, in order of arrival, the events parked on a failed instance, running first each
   * deadline that came due before the next of them, and writes `ProcessResumed` once none is
   * left. A step that fails is the new failure and the rest stay parked; an event that completes
   * the process completes it. Stops as soon as the instance is no longer failed on `letter`.
   */
  resumeParked(
    process: ProcessRuntime,
    instanceId: string,
    letter: string | undefined,
  ): Promise<void>;
}

export interface CreateResumeParkedArgs {
  readonly instances: ProcessInstances;
  readonly failures: ProcessFailures;
  readonly handlers: ProcessHandlers;
  readonly deadlineStep: DeadlineStep;
  readonly logger: Logger;
}

export interface CreateResumeParkedFunction {
  (args: CreateResumeParkedArgs): ResumeParked;
}

export const createResumeParked: CreateResumeParkedFunction = ({
  instances,
  failures,
  handlers,
  deadlineStep,
  logger,
}) => {
  const { load, append, appendPastParks, lostRace, parkedEvent } = instances;

  const handleParked = async (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    event: StoredEvent,
  ): Promise<boolean> => {
    if (handlerOf(process, event) === undefined) {
      if (!completesOn(process, event)) letThrough(process, instanceId, event, logger);
      await appendPastParks(
        process,
        instanceId,
        instance,
        handledEntries(process, event, instance.state),
      );
      return true;
    }
    let handled: HandlerRun;
    try {
      handled = await handlers.runEventHandler({
        process,
        event,
        instanceId,
        instance,
        attempt: 1,
      });
    } catch (error) {
      const current = await load(process, instanceId);
      if (current.failure?.eventId === event.id) return false;
      if (current.status !== "failed" || current.parked[0]?.eventId !== event.id) return true;
      const letter = failures.letterOf(process, event, error, 1, drainFailureType(error));
      await appendPastParks(process, instanceId, current, [
        lifecycleEntries.failed({ eventId: event.id }, letter, eventContext(event)),
      ]);
      await failures.fileLater(process, letter, error);
      return false;
    }
    await handled.record(() =>
      appendPastParks(process, instanceId, instance, handledEntries(process, event, handled.state)),
    );
    return true;
  };

  const drainDeadline = async (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    due: Deadline,
  ): Promise<boolean> => {
    try {
      await deadlineStep.run({
        process,
        instanceId,
        instance,
        due,
        context: instanceContext(process, instanceId, instance),
      });
      return true;
    } catch (error) {
      const current = await load(process, instanceId);
      const recorded = current.failure?.deadline;
      if (recorded !== undefined && reachedKey(recorded) === reachedKey(due)) return false;
      if (current.status !== "failed" || current.reached.has(reachedKey(due))) return true;
      const letter = failures.letterOf(
        process,
        deadlineSubject(process, instanceId, due.field),
        error,
        1,
        drainFailureType(error),
      );
      await appendPastParks(process, instanceId, current, [
        lifecycleEntries.failed(
          { deadline: due.field, at: due.at },
          letter,
          instanceContext(process, instanceId, current),
        ),
      ]);
      await failures.fileLater(process, letter, error);
      return false;
    }
  };

  const resumeParked = async (
    process: ProcessRuntime,
    instanceId: string,
    letter: string | undefined,
  ): Promise<void> => {
    for (;;) {
      const instance = await load(process, instanceId);
      if (instance.status !== "failed" || !blockedOn(instance, letter)) return;
      const [next] = instance.parked;
      const event = next === undefined ? undefined : await parkedEvent(next);
      const due = pendingDeadline(process, instance);
      if (
        event !== undefined &&
        due !== null &&
        Date.parse(due.at) <= Date.parse(event.timestamp)
      ) {
        if (!(await drainDeadline(process, instanceId, instance, due))) return;
        continue;
      }
      if (event === undefined) {
        try {
          await append(process, instanceId, instance, [
            lifecycleEntries.resumed(instanceContext(process, instanceId, instance)),
          ]);
          logger.info("process resumed", { process: process.name, aggregateId: instanceId });
          return;
        } catch (error) {
          if (!lostRace(process, instanceId, error)) throw error;
          continue;
        }
      }
      if (!(await handleParked(process, instanceId, instance, event))) return;
    }
  };

  return { resumeParked };
};
