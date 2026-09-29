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
import { createProcessInstances } from "./instances.ts";
import { createProcessReplay, type ProcessDeadLetters } from "./replay.ts";
import { createResumeParked } from "./resume.ts";
import { createDeadlineSchedule } from "./schedule.ts";

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
  const instances = createProcessInstances({ storage, ids, clock });
  const failures = createProcessFailures({ storage, ids, clock, logger });
  const handlers = createProcessHandlers({
    aggregates,
    pipeline,
    scheduler: storage.scheduler,
    config,
    clock,
    logger,
  });
  const schedule = createDeadlineSchedule({ storage, instances, failures });
  const deadlineStep = createDeadlineStep({ instances, handlers, ids });
  const resume = createResumeParked({ instances, failures, handlers, deadlineStep, logger });
  const events = createEventDelivery({
    instances,
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
    instances,
    failures,
    schedule,
    deadlineStep,
    config,
    clock,
    logger,
  });
  const deadLetters = createProcessReplay({
    processes,
    instances,
    failures,
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
