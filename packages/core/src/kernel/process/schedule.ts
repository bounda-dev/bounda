import type { StoragePorts } from "../../adapter/adapter.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import {
  type Deadline,
  nextDeadline,
  PROCESS_DEADLINE_COMMAND,
  type ProcessDeadlinePayload,
} from "./deadlines.ts";
import { deadlineContext, type ProcessInstance } from "./lifecycle.ts";
import type { ProcessUnits } from "./units.ts";

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
   * Stages in `unit` the entry of the instance as the unit sees it: its earliest pending deadline
   * while it runs, its removal otherwise. It commits with the lifecycle events that decide it, so
   * the two cannot disagree.
   */
  stage(unit: UnitOfWork, process: ProcessRuntime, instanceId: string): Promise<void>;
  /**
   * Removes the entry of an instance, even of a process no longer in the registry; staged in
   * `unit` when one is given.
   */
  cancel(
    process: string,
    instanceId: string,
    unit?: Pick<UnitOfWork, "scheduler"> | undefined,
  ): Promise<void>;
}

export interface CreateDeadlineScheduleArgs {
  readonly storage: StoragePorts;
  readonly units: ProcessUnits;
}

export interface CreateDeadlineScheduleFunction {
  (args: CreateDeadlineScheduleArgs): DeadlineSchedule;
}

const deadlineKey = (process: string, instanceId: string): string =>
  `process-deadline:${process}:${instanceId}`;

export const createDeadlineSchedule: CreateDeadlineScheduleFunction = ({ storage, units }) => ({
  stage: async (unit, process, instanceId) => {
    const dedupeKey = deadlineKey(process.name, instanceId);
    const instance = await units.over(unit).load(process, instanceId);
    const next = instance.status === "started" ? pendingDeadline(process, instance) : null;
    if (next === null) {
      await unit.scheduler.cancel(dedupeKey);
      return;
    }
    await unit.scheduler.schedule({
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
      context: deadlineContext(process, instanceId, instance, next),
      keepTimingOfSameCommand: true,
    });
  },
  cancel: (process, instanceId, unit = storage) =>
    unit.scheduler.cancel(deadlineKey(process, instanceId)),
});
