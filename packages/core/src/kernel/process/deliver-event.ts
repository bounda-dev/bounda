import type { Storage } from "../../adapter/adapter.ts";
import type { NewDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ClaimLostError, ConcurrencyError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import { causedBy } from "../shared/causation.ts";
import type { ReactionOutcome } from "../shared/in-order.ts";
import type { PendingRetries } from "../shared/pending-retries.ts";
import { runAttempt } from "../shared/reaction-attempt.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import type { ProcessFailures } from "./failures.ts";
import type { ProcessHandlers } from "./handlers.ts";
import { type LifecycleEntry, lifecycleEntries, type ProcessInstance } from "./lifecycle.ts";
import { actsOn, completesOn, followsUp, handledEntries, handlerOf, startsOn } from "./routes.ts";
import type { DeadlineSchedule } from "./schedule.ts";
import type { ProcessUnits } from "./units.ts";

/**
 * How the dispatcher's events reach process instances.
 */
export interface EventDelivery {
  /**
   * What one event does to its instance is one unit of work: the start, the handler's commands,
   * the lifecycle events, the deadline entry and, for an event its handler runs on, the inbox
   * claim, committed together or not at all. An event for an instance that has ended, or that
   * was handled already, takes no claim and writes nothing, except a follow-up of a timed-out
   * instance: its handler runs as on a running one, and a failure files a letter only. A retriable failure holds the event for the inbox ledger to
   * retry. A commit that finds the instance moved, by a deadline or another instance, runs the
   * step again on the instance as it now is, up to `runtime.commands.concurrencyRetries` times,
   * without spending an attempt. An event for a failed instance is parked behind the failure.
   */
  deliver(process: ProcessRuntime, event: StoredEvent): Promise<ReactionOutcome>;
}

export interface CreateEventDeliveryArgs {
  readonly units: ProcessUnits;
  readonly failures: ProcessFailures;
  readonly handlers: ProcessHandlers;
  readonly schedule: DeadlineSchedule;
  readonly storage: Storage;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly pendingRetries: PendingRetries;
  readonly logger: Logger;
}

export interface CreateEventDeliveryFunction {
  (args: CreateEventDeliveryArgs): EventDelivery;
}

export const createEventDelivery: CreateEventDeliveryFunction = ({
  units,
  failures,
  handlers,
  schedule,
  storage,
  config,
  clock,
  pendingRetries,
  logger,
}) => {
  const leaseMs = (process: ProcessRuntime): number => process.handlerTimeoutMs * 2;

  // Whether `event` waits behind the instance's failure: not the event that failed, delivered
  // again, and nothing once the failure's letter was discarded, since the instance is given up.
  // A letter is written with the failure, so one that is gone was purged once resolved: an
  // instance still failed on it was given up.
  const parks = async (
    unit: UnitOfWork,
    process: ProcessRuntime,
    event: StoredEvent,
    instance: ProcessInstance,
  ): Promise<boolean> => {
    if (
      !actsOn(process, event) ||
      event.id === instance.failure?.eventId ||
      instance.handledEventIds.has(event.id) ||
      instance.parked.some((parked) => parked.eventId === event.id)
    ) {
      return false;
    }
    const letterId = instance.failure?.letterId;
    if (letterId === undefined) return true;
    const letter = await unit.deadLetterStore.get(letterId);
    return letter !== null && letter.status !== "discarded";
  };

  // The instance with its start staged in `entries` when `event` starts it; as it is otherwise.
  const started = (
    process: ProcessRuntime,
    event: StoredEvent,
    instance: ProcessInstance,
    entries: LifecycleEntry[],
  ): ProcessInstance => {
    if (instance.exists || !startsOn(process, event)) return instance;
    const timeoutAt = new Date(Date.parse(event.timestamp) + process.lifetimeMs).toISOString();
    entries.push(lifecycleEntries.started(event, process.initialState, timeoutAt));
    return { ...instance, exists: true, timeoutAt, correlationId: event.metadata.correlationId };
  };

  // Stages what `event` does to its instance; resolves to whether it was parked.
  const step = async (
    unit: UnitOfWork,
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    attempt: number,
  ): Promise<boolean> => {
    const within = units.over(unit);
    const entries: LifecycleEntry[] = [];
    const instance = started(process, event, await within.load(process, instanceId), entries);
    if (!instance.exists) return false;
    let parked = false;
    if (instance.status === "failed") {
      if (await parks(unit, process, event, instance)) {
        entries.push(lifecycleEntries.parked(event));
        parked = true;
      }
    } else if (instance.status === "started" || followsUp(process, instance, event)) {
      if (handlerOf(process, event) !== undefined && !instance.handledEventIds.has(event.id)) {
        const state = await handlers.runEventHandler({
          process,
          event,
          instanceId,
          instance,
          attempt,
          within: unit,
        });
        entries.push(...handledEntries(process, instance, event, state));
      } else if (completesOn(process, event)) {
        entries.push(lifecycleEntries.completed(event));
      }
    }
    if (entries.length === 0) return false;
    await within.append(process, instanceId, instance, entries);
    await schedule.stage(unit, process, instanceId);
    return parked;
  };

  const parkedLog = (process: ProcessRuntime, event: StoredEvent, instanceId: string): void => {
    logger.info("process event parked behind a failure", {
      process: process.name,
      aggregateId: instanceId,
      eventId: event.id,
    });
  };

  // Stages what giving up on `event` records: the dead letter, and `ProcessFailed` while the
  // instance still runs, after its start when `event` is what starts it, with its deadline entry.
  // Resolves to the letter, sealed under whom the event or else the instance's state names.
  const failFor = async (
    unit: UnitOfWork,
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    letterOf: (instance: ProcessInstance) => Promise<NewDeadLetter>,
  ): Promise<NewDeadLetter> => {
    const within = units.over(unit);
    const entries: LifecycleEntry[] = [];
    const current = started(process, event, await within.load(process, instanceId), entries);
    const letter = await letterOf(current);
    if (current.status === "started") {
      entries.push(lifecycleEntries.failed({ eventId: event.id }, letter, causedBy(event)));
      await within.append(process, instanceId, current, entries);
      await schedule.stage(unit, process, instanceId);
    }
    await unit.deadLetterStore.add(letter);
    return letter;
  };

  const handle = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
  ): Promise<ReactionOutcome> => {
    let parked = false;
    let letter: NewDeadLetter | undefined;
    const outcome = await runAttempt({
      storage,
      key: { handler: process.name, eventId: event.id },
      retry: config.forAggregate(process.aggregate).processes.retry,
      leaseMs: leaseMs(process),
      concurrencyRetries: config.runtime.commands.concurrencyRetries,
      clock,
      pendingRetries,
      run: async (unit, attempt) => {
        parked = await step(unit, process, event, instanceId, attempt);
      },
      giveUp: async (unit, error, attempts, errorType) => {
        letter = await failFor(unit, process, event, instanceId, (instance) =>
          failures.letterOf(
            process,
            failures.subjectOf(process, event, { instanceId, instance }),
            error,
            attempts,
            errorType,
          ),
        );
      },
      gaveUp: () => {
        if (letter !== undefined) failures.filed(process, letter);
      },
      willRetry: (attempts, error) => {
        logger.warn("process handler failed; will retry", {
          process: process.name,
          eventId: event.id,
          attempts,
          error,
        });
      },
    });
    if (parked && outcome === "done") parkedLog(process, event, instanceId);
    return outcome;
  };

  const uncorrelated = async (
    process: ProcessRuntime,
    event: StoredEvent,
    error: unknown,
  ): Promise<ReactionOutcome> => {
    const key = { handler: process.name, eventId: event.id };
    if ((await storage.inboxLedger.get(key))?.status === "succeeded") return "done";
    const claimId = await storage.inboxLedger.tryClaim({
      ...key,
      now: clock.now(),
      leaseMs: leaseMs(process),
    });
    if (claimId === null) return "hold";
    const letter = await failures.letterOf(
      process,
      failures.subjectOf(process, event, null),
      error,
      1,
      "terminal",
    );
    try {
      await units.commit(async (unit) => {
        await unit.deadLetterStore.add(letter);
        await unit.inboxLedger.complete({ ...key, claimId });
      });
    } catch (failure) {
      if (failure instanceof ClaimLostError) return "hold";
      throw failure;
    }
    failures.filed(process, letter);
    return "done";
  };

  const handleEvent = async (
    process: ProcessRuntime,
    event: StoredEvent,
  ): Promise<ReactionOutcome> => {
    let instanceId: string | null;
    try {
      instanceId = process.instanceOf(event);
    } catch (error) {
      return uncorrelated(process, event, error);
    }
    if (instanceId === null) return "done";
    // Routed on the instance as the store holds it; the step loads it again through its unit.
    const instance = await units.live.load(process, instanceId);
    if (followsUp(process, instance, event)) return handle(process, event, instanceId);
    const ended = instance.exists
      ? instance.status === "completed" || instance.status === "timed_out"
      : !startsOn(process, event);
    if (ended) return "done";
    if (
      instance.status === "started" &&
      handlerOf(process, event) !== undefined &&
      !instance.handledEventIds.has(event.id)
    ) {
      return handle(process, event, instanceId);
    }
    let parked = false;
    await units.commit(async (unit) => {
      parked = await step(unit, process, event, instanceId, 1);
    });
    if (parked) parkedLog(process, event, instanceId);
    return "done";
  };

  return {
    deliver: async (process, event) => {
      try {
        return await handleEvent(process, event);
      } catch (error) {
        if (!(error instanceof ConcurrencyError)) throw error;
        logger.debug("process stream moved; will redeliver", {
          process: process.name,
          eventId: event.id,
        });
        return "hold";
      }
    },
  };
};
