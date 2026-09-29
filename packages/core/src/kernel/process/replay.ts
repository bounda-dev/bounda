import type { DeadLetter } from "../../adapter/ports/dead-letter-store.ts";
import { ConfigurationError, NotFoundError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { ProcessesRuntime, ProcessRuntime } from "./build-processes.ts";
import type { DeadlineStep } from "./deadline-step.ts";
import { PROCESS_DEADLINE_COMMAND, reachedKey } from "./deadlines.ts";
import type { DeadlineTarget } from "./deliver-deadline.ts";
import { blockedOn, type ProcessFailures } from "./failures.ts";
import type { ProcessHandlers } from "./handlers.ts";
import type { ProcessInstances } from "./instances.ts";
import { lifecycleEntries, type ProcessInstance } from "./lifecycle.ts";
import type { ResumeParked } from "./resume.ts";
import { completesOn, handledEntries, handlerOf, letThrough } from "./routes.ts";
import type { DeadlineSchedule } from "./schedule.ts";

interface ReplayArgs {
  /**
   * Identifies this replay, so the handler's `idempotencyKey` differs from the failed run's.
   */
  readonly replay: string;
  /**
   * The id of the dead letter being replayed: the replay goes on only while it is the failure its
   * instance is blocked on.
   */
  readonly letter?: string | undefined;
}

export interface ReplayProcessArgs extends ReplayArgs {
  /**
   * The process name as a dead letter records it, e.g. `order.orderPayment`.
   */
  readonly process: string;
  readonly event: StoredEvent;
}

export interface ReplayDeadlineArgs extends ReplayArgs {
  readonly payload: DeadlineTarget;
  readonly context: CausationContext;
}

/**
 * What the dead letters ask of processes about the letters they file.
 */
export interface ProcessDeadLetters {
  /**
   * Ignores the inbox ledger. A failed process then drains its parked events in order before it
   * resumes; one that fails again becomes the new failure, and the rest stay parked.
   */
  replay(args: ReplayProcessArgs): Promise<void>;
  /**
   * Runs again the deadline a process failed on, with a new `idempotencyKey`, then resumes the
   * instance as `replay` does.
   */
  replayDeadline(args: ReplayDeadlineArgs): Promise<void>;
  /**
   * How many events wait behind a process dead letter: those parked on its instance while the
   * failure it records keeps the instance failed. `0` for any other letter.
   */
  parkedBehind(letter: DeadLetter): Promise<number>;
  /**
   * After a replay of a process dead letter: how many steps of its instance still wait because
   * the process failed again, the one it failed on included, whether an event or a deadline. `0`
   * once it resumed.
   */
  stillParked(letter: DeadLetter): Promise<number>;
}

export interface CreateProcessReplayArgs {
  readonly processes: ProcessesRuntime;
  readonly instances: ProcessInstances;
  readonly failures: ProcessFailures;
  readonly handlers: ProcessHandlers;
  readonly schedule: DeadlineSchedule;
  readonly deadlineStep: DeadlineStep;
  readonly resume: ResumeParked;
  readonly logger: Logger;
}

export interface CreateProcessReplayFunction {
  (args: CreateProcessReplayArgs): ProcessDeadLetters;
}

const failedOnAnotherStep = (process: ProcessRuntime, instanceId: string): ConfigurationError =>
  new ConfigurationError(
    `Process "${process.name}" is failed on another step for ${instanceId}; replay the dead letter of that failure first`,
  );

const registered = (processes: ProcessesRuntime, name: string): ProcessRuntime => {
  const process = processes.byName[name];
  if (process === undefined) {
    throw new ConfigurationError(`Process "${name}" is no longer in the registry`);
  }
  return process;
};

export const createProcessReplay: CreateProcessReplayFunction = ({
  processes,
  instances,
  failures,
  handlers,
  schedule,
  deadlineStep,
  resume,
  logger,
}) => {
  const { load, appendPastParks } = instances;

  const completeOnReplay = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
  ): Promise<void> => {
    if (!completesOn(process, event)) return;
    const current = await load(process, instanceId);
    if (current.status !== "started" && current.status !== "failed") return;
    await appendPastParks(process, instanceId, current, [lifecycleEntries.completed(event)]);
  };

  const replay = async ({
    process: name,
    event,
    replay,
    letter,
  }: ReplayProcessArgs): Promise<void> => {
    const process = registered(processes, name);
    const instanceId = process.instanceOf(event);
    const instance = instanceId === null ? null : await load(process, instanceId);
    const failedHere =
      instance?.status === "failed" &&
      instance.failure?.eventId === event.id &&
      blockedOn(instance, letter);
    const handler = handlerOf(process, event);
    if (handler === undefined && !failedHere) {
      throw new ConfigurationError(`Process "${name}" no longer handles ${event.type}`);
    }
    if (instanceId === null || instance === null || !instance.exists) {
      throw new NotFoundError(
        `Process "${name}" has no instance for ${event.aggregateType}:${event.aggregateId}`,
      );
    }
    if (instance.status === "failed" && !failedHere) {
      await failures.healFailure(process, instance);
      throw failedOnAnotherStep(process, instanceId);
    }
    if (instance.handledEventIds.has(event.id)) {
      await completeOnReplay(process, event, instanceId);
    } else {
      const write = (state: object) => () =>
        appendPastParks(process, instanceId, instance, handledEntries(process, event, state));
      if (handler === undefined) {
        letThrough(process, instanceId, event, logger);
        await write(instance.state)();
      } else {
        const handled = await handlers.runEventHandler({
          process,
          event,
          instanceId,
          instance,
          attempt: 1,
          replay,
        });
        await handled.record(write(handled.state));
      }
    }
    await resume.resumeParked(process, instanceId, letter);
    await schedule.reconcile(process, instanceId);
    logger.info("process handler replayed", { process: process.name, eventId: event.id });
  };

  const replayDeadline = async ({
    payload,
    context,
    replay,
    letter,
  }: ReplayDeadlineArgs): Promise<void> => {
    const process = registered(processes, payload.process);
    const instance = await load(process, payload.aggregateId);
    const failed = instance.failure?.deadline;
    if (instance.status === "failed" && !blockedOn(instance, letter)) {
      await failures.healFailure(process, instance);
      throw failedOnAnotherStep(process, payload.aggregateId);
    }
    if (instance.status !== "failed" || failed === undefined) {
      throw new NotFoundError(
        `Process "${process.name}" has no failed deadline for ${payload.aggregateId}`,
      );
    }
    if (!instance.reached.has(reachedKey(failed))) {
      await deadlineStep.attempt({
        process,
        instanceId: payload.aggregateId,
        instance,
        due: failed,
        context: { ...context, correlationId: instance.correlationId ?? context.correlationId },
        replay,
      });
    }
    await resume.resumeParked(process, payload.aggregateId, letter);
    await schedule.reconcile(process, payload.aggregateId);
  };

  const instanceOfLetter = async (letter: DeadLetter): Promise<ProcessInstance | null> => {
    const process = processes.byName[letter.subscriber];
    if (letter.kind !== "process" || process === undefined) return null;
    const instanceId =
      letter.eventType === PROCESS_DEADLINE_COMMAND
        ? letter.aggregateId
        : await instances
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
    replay,
    replayDeadline,
    parkedBehind: async (letter) => {
      const instance = letter.status === "failed" ? await instanceOfLetter(letter) : null;
      const failure = instance?.failure;
      return instance?.status === "failed" && failure?.letter?.id === letter.id
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
