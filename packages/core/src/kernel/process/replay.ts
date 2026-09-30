import type { DeadLetter } from "../../adapter/ports/dead-letter-store.ts";
import { ConfigurationError, NotFoundError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import { causeOf } from "../unit-of-work/unit-of-work.ts";
import type { ProcessesRuntime, ProcessRuntime } from "./build-processes.ts";
import type { DeadlineStep } from "./deadline-step.ts";
import { PROCESS_DEADLINE_COMMAND, reachedKey } from "./deadlines.ts";
import type { DeadlineTarget } from "./deliver-deadline.ts";
import { blockedOn } from "./failures.ts";
import type { ProcessHandlers } from "./handlers.ts";
import { lifecycleEntries, type ProcessInstance } from "./lifecycle.ts";
import type { ResumeParked } from "./resume.ts";
import { completesOn, handledEntries, handlerOf, letThrough } from "./routes.ts";
import type { DeadlineSchedule } from "./schedule.ts";
import type { ProcessUnits } from "./units.ts";

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
   * Ignores the inbox ledger. The replayed step is one unit of work; a failed process then drains
   * its parked events in order before it resumes, one unit each; one that fails again becomes the
   * new failure, and the rest stay parked.
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
  readonly units: ProcessUnits;
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
  units,
  handlers,
  schedule,
  deadlineStep,
  resume,
  logger,
}) => {
  const { load } = units.live;

  const committed = async (work: Parameters<ProcessUnits["commit"]>[0]): Promise<void> => {
    try {
      await units.commit(work);
    } catch (error) {
      throw causeOf(error);
    }
  };

  const resumed = async (
    process: ProcessRuntime,
    instanceId: string,
    letter: string | undefined,
  ): Promise<void> => {
    try {
      await resume.resumeParked(process, instanceId, letter);
    } catch (error) {
      throw causeOf(error);
    }
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
    if (instance.status === "failed" && !failedHere) throw failedOnAnotherStep(process, instanceId);
    await committed(async (unit, within) => {
      const current = await within.load(process, instanceId);
      if (current.status !== "started" && current.status !== "failed") return;
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
            replay,
            within: unit,
          });
        }
        await within.append(process, instanceId, current, handledEntries(process, event, state));
      }
      await schedule.stage(unit, process, instanceId);
    });
    await resumed(process, instanceId, letter);
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
      throw failedOnAnotherStep(process, payload.aggregateId);
    }
    if (instance.status !== "failed" || failed === undefined) {
      throw new NotFoundError(
        `Process "${process.name}" has no failed deadline for ${payload.aggregateId}`,
      );
    }
    await committed(async (unit, within) => {
      const current = await within.load(process, payload.aggregateId);
      if (current.reached.has(reachedKey(failed))) return;
      await deadlineStep.attempt({
        unit,
        process,
        instanceId: payload.aggregateId,
        instance: current,
        due: failed,
        context: { ...context, correlationId: current.correlationId ?? context.correlationId },
        replay,
      });
      await schedule.stage(unit, process, payload.aggregateId);
    });
    await resumed(process, payload.aggregateId, letter);
  };

  const instanceOfLetter = async (letter: DeadLetter): Promise<ProcessInstance | null> => {
    const process = processes.byName[letter.subscriber];
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
    replay,
    replayDeadline,
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
