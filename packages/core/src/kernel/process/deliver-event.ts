import type { StoragePorts } from "../../adapter/adapter.ts";
import type { DeadLetterErrorType } from "../../adapter/ports/dead-letter-store.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConcurrencyError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { ReactionOutcome } from "../shared/in-order.ts";
import { runClaimed } from "../shared/inbox-claim.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import type { ProcessFailures } from "./failures.ts";
import type { ProcessHandlers } from "./handlers.ts";
import type { ProcessInstances } from "./instances.ts";
import { eventContext, lifecycleEntries, type ProcessInstance } from "./lifecycle.ts";
import { actsOn, completesOn, handledEntries, handlerOf, startsOn } from "./routes.ts";
import type { DeadlineSchedule } from "./schedule.ts";

/**
 * How the dispatcher's events reach process instances.
 */
export interface EventDelivery {
  /**
   * Delivers `event` to the instance of `process` it belongs to. An event that starts the
   * process writes `ProcessStarted` with the moment it times out; an event with a handler runs
   * it and writes `ProcessHandled` with the new state; a completing event writes
   * `ProcessCompleted`. Terminal failures are recorded as `ProcessFailed` and dead-lettered;
   * retriable ones hold the event, retried with back-off through the inbox ledger. When another
   * write to the instance, such as a deadline, gets there before `ProcessHandled`, the handler
   * runs again on the instance as it now is, up to `runtime.commands.concurrencyRetries` times,
   * without spending an attempt. An event for a failed instance is parked behind the failure.
   * The instance's deadlines are reconciled after every delivery to it.
   */
  deliver(process: ProcessRuntime, event: StoredEvent): Promise<ReactionOutcome>;
}

export interface CreateEventDeliveryArgs {
  readonly instances: ProcessInstances;
  readonly failures: ProcessFailures;
  readonly handlers: ProcessHandlers;
  readonly schedule: DeadlineSchedule;
  readonly storage: StoragePorts;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateEventDeliveryFunction {
  (args: CreateEventDeliveryArgs): EventDelivery;
}

export const createEventDelivery: CreateEventDeliveryFunction = ({
  instances,
  failures,
  handlers,
  schedule,
  storage,
  config,
  clock,
  logger,
}) => {
  const { load, append, lostRace } = instances;

  const leaseMs = (process: ProcessRuntime): number =>
    config.forAggregate(process.aggregate).policies.timeoutMs * 2;

  const start = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    instance: ProcessInstance,
  ): Promise<ProcessInstance> => {
    const timeoutAt = new Date(Date.parse(event.timestamp) + process.timeoutMs).toISOString();
    await append(process, instanceId, instance, [
      lifecycleEntries.started(event, process.initialState, timeoutAt),
    ]);
    return {
      ...instance,
      exists: true,
      version: instance.version + 1,
      timeoutAt,
      correlationId: event.metadata.correlationId,
    };
  };

  const failFor = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    instance: ProcessInstance,
    error: unknown,
    attempts: number,
    errorType: DeadLetterErrorType,
  ): Promise<void> => {
    const letter = failures.letterOf(process, event, error, attempts, errorType);
    await append(process, instanceId, instance, [
      lifecycleEntries.failed({ eventId: event.id }, letter, eventContext(event)),
    ]);
    await failures.file(process, letter, error);
  };

  const handle = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    instance: ProcessInstance,
  ): Promise<ReactionOutcome> => {
    if (handlerOf(process, event) === undefined || instance.handledEventIds.has(event.id)) {
      return "done";
    }
    return runClaimed({
      ledger: storage.inboxLedger,
      key: { subscriber: process.name, eventId: event.id },
      retry: config.forAggregate(process.aggregate).processes.retry,
      leaseMs: leaseMs(process),
      clock,
      run: async (attempt) => {
        let current = instance;
        for (let race = 0; ; race += 1) {
          const handled = await handlers.runEventHandler({
            process,
            event,
            instanceId,
            instance: current,
            attempt,
          });
          const recording = current;
          try {
            await handled.record(() =>
              append(process, instanceId, recording, handledEntries(process, event, handled.state)),
            );
            return;
          } catch (error) {
            if (
              !lostRace(process, instanceId, error) ||
              race >= config.runtime.commands.concurrencyRetries
            ) {
              throw error;
            }
            current = await load(process, instanceId);
            if (current.status !== "started") throw error;
          }
        }
      },
      giveUp: (error, attempts, errorType) =>
        failFor(process, event, instanceId, instance, error, attempts, errorType),
      willRetry: (attempts) => {
        logger.warn("process handler failed; will retry", {
          process: process.name,
          eventId: event.id,
          attempts,
        });
      },
    });
  };

  const park = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    instance: ProcessInstance,
  ): Promise<void> => {
    if ((await failures.healFailure(process, instance))?.status === "discarded") return;
    if (
      !actsOn(process, event) ||
      event.id === instance.failure?.eventId ||
      instance.handledEventIds.has(event.id) ||
      instance.parked.some((parked) => parked.eventId === event.id)
    ) {
      return;
    }
    await append(process, instanceId, instance, [lifecycleEntries.parked(event)]);
    logger.info("process event parked behind a failure", {
      process: process.name,
      aggregateId: instanceId,
      eventId: event.id,
    });
  };

  const parkUntilLanded = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    instance: ProcessInstance,
  ): Promise<ProcessInstance> => {
    let current = instance;
    while (current.status === "failed") {
      try {
        await park(process, event, instanceId, current);
        return current;
      } catch (error) {
        if (!lostRace(process, instanceId, error)) throw error;
        current = await load(process, instanceId);
      }
    }
    return current;
  };

  const completeIfDue = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
  ): Promise<void> => {
    if (!completesOn(process, event)) return;
    const current = await load(process, instanceId);
    if (current.status === "failed") {
      await parkUntilLanded(process, event, instanceId, current);
      return;
    }
    if (current.status !== "started") return;
    await append(process, instanceId, current, [lifecycleEntries.completed(event)]);
  };

  const uncorrelated = async (
    process: ProcessRuntime,
    event: StoredEvent,
    error: unknown,
  ): Promise<ReactionOutcome> => {
    const key = { subscriber: process.name, eventId: event.id };
    if ((await storage.inboxLedger.get(key))?.status === "succeeded") return "done";
    const claimed = await storage.inboxLedger.tryClaim({
      ...key,
      now: clock.now(),
      leaseMs: leaseMs(process),
    });
    if (!claimed) return "hold";
    await failures.file(process, failures.letterOf(process, event, error, 1, "terminal"), error);
    await storage.inboxLedger.complete(key);
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
    let instance = await load(process, instanceId);
    if (!instance.exists) {
      if (!startsOn(process, event)) return "done";
      instance = await start(process, event, instanceId, instance);
    }
    if (instance.status === "failed") {
      instance = await parkUntilLanded(process, event, instanceId, instance);
      if (instance.status === "failed") return "done";
    }
    if (instance.status !== "started") return "done";
    const outcome = await handle(process, event, instanceId, instance);
    if (outcome === "done") await completeIfDue(process, event, instanceId);
    await schedule.reconcile(process, instanceId);
    return outcome;
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
