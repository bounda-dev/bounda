import type { StoragePorts } from "../../adapter/adapter.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import {
  type Deadline,
  nextDeadline,
  PROCESS_DEADLINE_COMMAND,
  type ProcessDeadlinePayload,
} from "./deadlines.ts";
import type { ProcessFailures } from "./failures.ts";
import type { ProcessInstances } from "./instances.ts";
import { instanceContext, type ProcessInstance } from "./lifecycle.ts";

export interface PendingDeadlineFunction {
  (process: ProcessRuntime, instance: ProcessInstance): Deadline | null;
}

/**
 * The deadline the instance reaches next, whether or not it is running; `null` when none is left.
 */
export const pendingDeadline: PendingDeadlineFunction = (process, instance) =>
  nextDeadline({
    fields: process.deadlineFields,
    state: instance.state,
    timeoutAt: instance.timeoutAt,
    reached: instance.reached,
  });

/**
 * The one scheduler entry each process instance has, set to its earliest pending deadline.
 */
export interface DeadlineSchedule {
  /**
   * Sets the instance's entry to its earliest pending deadline while it is running, and removes
   * it otherwise. The instance is read again after the entry is written, and the write repeated
   * if the stream moved meanwhile, so the last write always reflects the latest state.
   */
  reconcile(process: ProcessRuntime, instanceId: string): Promise<void>;
  /**
   * Removes the entry of an instance, even of a process no longer in the registry.
   */
  cancel(process: string, instanceId: string): Promise<void>;
}

export interface CreateDeadlineScheduleArgs {
  readonly storage: StoragePorts;
  readonly instances: ProcessInstances;
  readonly failures: ProcessFailures;
}

export interface CreateDeadlineScheduleFunction {
  (args: CreateDeadlineScheduleArgs): DeadlineSchedule;
}

const deadlineKey = (process: string, instanceId: string): string =>
  `process-deadline:${process}:${instanceId}`;

export const createDeadlineSchedule: CreateDeadlineScheduleFunction = ({
  storage,
  instances,
  failures,
}) => ({
  reconcile: async (process, instanceId) => {
    const dedupeKey = deadlineKey(process.name, instanceId);
    let instance = await instances.load(process, instanceId);
    for (;;) {
      const next = instance.status === "started" ? pendingDeadline(process, instance) : null;
      if (next === null) {
        await failures.healFailure(process, instance);
        await storage.scheduler.cancel(dedupeKey);
      } else {
        await storage.scheduler.schedule({
          dedupeKey,
          command: {
            type: PROCESS_DEADLINE_COMMAND,
            aggregateId: instanceId,
            payload: {
              process: process.name,
              aggregateId: instanceId,
              ...next,
            } satisfies ProcessDeadlinePayload,
          },
          executeAt: new Date(next.at),
          context: instanceContext(process, instanceId, instance),
          keepTimingOfSameCommand: true,
        });
      }
      const current = await instances.load(process, instanceId);
      if (current.version === instance.version) return;
      instance = current;
    }
  },
  cancel: (process, instanceId) => storage.scheduler.cancel(deadlineKey(process, instanceId)),
});
