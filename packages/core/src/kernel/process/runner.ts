import type { StoragePorts } from "../../adapter/adapter.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import { deliverInOrder } from "../shared/in-order.ts";
import type { ProcessesRuntime } from "./build-processes.ts";
import { createDeadlineStep } from "./deadline-step.ts";
import { createDeadlineDelivery, type ProcessDeadlines } from "./deliver-deadline.ts";
import { createEventDelivery } from "./deliver-event.ts";
import { createProcessFailures } from "./failures.ts";
import { createProcessHandlers } from "./handlers.ts";
import { createProcessReplay, type ProcessDeadLetters } from "./replay.ts";
import { createResumeParked } from "./resume.ts";
import { createDeadlineSchedule } from "./schedule.ts";
import { createProcessUnits } from "./units.ts";

export const PROCESSES_SUBSCRIBER: "processes" = "processes";

export interface ProcessRunner extends Subscriber, ProcessDeadlines, ProcessDeadLetters {}

export interface CreateProcessRunnerArgs {
  readonly processes: ProcessesRuntime;
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly storage: StoragePorts;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateProcessRunnerFunction {
  (args: CreateProcessRunnerArgs): ProcessRunner;
}

/**
 * A process that holds an event is handed none of the later events of the batch, so none of them
 * overtakes it.
 */
export const createProcessRunner: CreateProcessRunnerFunction = ({
  processes,
  aggregates,
  pipeline,
  storage,
  config,
  ids,
  clock,
  logger,
}) => {
  const units = createProcessUnits({ storage, config, ids, clock });
  const failures = createProcessFailures({ ids, clock, logger });
  const handlers = createProcessHandlers({ aggregates, pipeline, config, clock });
  const schedule = createDeadlineSchedule({ storage, units });
  const deadlineStep = createDeadlineStep({ units, handlers, ids });
  const resume = createResumeParked({ units, failures, handlers, deadlineStep, schedule, logger });
  const events = createEventDelivery({
    units,
    failures,
    handlers,
    schedule,
    storage,
    config,
    clock,
    logger,
  });
  const deadlines = createDeadlineDelivery({
    processes,
    units,
    failures,
    schedule,
    deadlineStep,
    config,
    clock,
    logger,
  });
  const deadLetters = createProcessReplay({
    processes,
    units,
    handlers,
    schedule,
    deadlineStep,
    resume,
    logger,
  });
  return {
    name: PROCESSES_SUBSCRIBER,
    kind: "process",
    process: (batch) =>
      deliverInOrder({ events: batch, byEvent: processes.byEvent, deliver: events.deliver }),
    handleDeadline: deadlines.handleDeadline,
    failDeadline: deadlines.failDeadline,
    lostRace: deadlines.lostRace,
    retryOf: deadlines.retryOf,
    replay: deadLetters.replay,
    replayDeadline: deadLetters.replayDeadline,
    parkedBehind: deadLetters.parkedBehind,
    stillParked: deadLetters.stillParked,
  };
};
