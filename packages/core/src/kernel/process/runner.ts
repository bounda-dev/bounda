import type { StoragePorts } from "../../adapter/adapter.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConcurrencyError, ConfigurationError, NotFoundError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { createCommandsFacade } from "../command/facade.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "../shared/retry.ts";
import { withTimeout } from "../shared/timeout.ts";
import { ATTRIBUTES, deadLettered, traced } from "../telemetry.ts";
import type { ProcessesRuntime, ProcessRuntime } from "./build-processes.ts";
import {
  foldProcess,
  PROCESS_EVENTS,
  type ProcessInstance,
  processAggregateType,
} from "./lifecycle.ts";

export const PROCESSES_SUBSCRIBER: "processes" = "processes";

/**
 * The command type the scheduler holds for a process timeout. Routed to the process runner, never
 * to a user command handler.
 */
export const PROCESS_TIMEOUT_COMMAND: "bounda.ProcessTimeout" = "bounda.ProcessTimeout";

export interface ProcessTimeoutPayload {
  readonly process: string;
  readonly aggregateId: string;
}

export interface ReplayProcessArgs {
  /**
   * The process name as a dead letter records it, e.g. `order.orderPayment`.
   */
  readonly process: string;
  readonly event: StoredEvent;
}

export interface ProcessRunner extends Subscriber {
  /**
   * Called by the scheduled-command worker when a process timeout comes due.
   */
  handleTimeout(args: {
    readonly payload: ProcessTimeoutPayload;
    readonly context: CausationContext;
  }): Promise<void>;
  /**
   * Runs a process handler again for an event whose earlier run was dead-lettered, ignoring the
   * inbox ledger. On success the instance gets its `ProcessHandled`, a process that had failed
   * is back to `started` with its timeout re-armed at the original deadline, and an event that
   * completes the process completes it.
   */
  replay(args: ReplayProcessArgs): Promise<void>;
}

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

type Outcome = "done" | "hold";

const timeoutKey = (process: ProcessRuntime, aggregateId: string): string =>
  `process-timeout:${process.name}:${aggregateId}`;

/**
 * Runs processes as internal aggregates: each instance is a stream of lifecycle events under
 * `process:<Type>:<aggregateId>`, appended with optimistic concurrency. An event that starts a
 * process writes `ProcessStarted` and schedules the timeout; an event with a handler, the starting
 * one included, runs it and writes `ProcessHandled` with the new state; a completing event writes
 * `ProcessCompleted` and cancels the timeout. Failures follow the same rules as policies: terminal ones are recorded as
 * `ProcessFailed` and dead-lettered, retriable ones hold the checkpoint and are retried with
 * back-off through the inbox ledger.
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
  const load = async (process: ProcessRuntime, aggregateId: string): Promise<ProcessInstance> => {
    const loaded = await storage.eventStore.load({
      aggregateType: processAggregateType(process.type),
      aggregateId,
    });
    return foldProcess({ initialState: process.initialState, events: loaded.events });
  };

  const append = async (
    process: ProcessRuntime,
    aggregateId: string,
    instance: ProcessInstance,
    type: string,
    payload: unknown,
    context: CausationContext,
  ): Promise<void> => {
    const aggregateType = processAggregateType(process.type);
    await storage.eventStore.append({
      aggregateType,
      aggregateId,
      expectedVersion: instance.version,
      events: [
        {
          id: ids.next(),
          aggregateType,
          aggregateId,
          version: instance.version + 1,
          type,
          payload,
          timestamp: clock.now().toISOString(),
          metadata: { ...context, schemaVersion: 1, system: true },
        },
      ],
    });
  };

  const contextOf = (event: StoredEvent): CausationContext => ({
    correlationId: event.metadata.correlationId,
    causationId: event.id,
    depth: event.metadata.depth,
  });

  const facadeFor = (context: CausationContext) =>
    createCommandsFacade({ aggregates, pipeline, context });

  const deadLetter = async (
    process: ProcessRuntime,
    event: StoredEvent,
    error: unknown,
    attempts: number,
    errorType: "terminal" | "retriable_exhausted",
  ): Promise<void> => {
    const details = errorDetails(error);
    const now = clock.now().toISOString();
    await storage.deadLetterStore.add({
      id: ids.next(),
      kind: "process",
      subscriber: process.name,
      eventId: event.id,
      eventType: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      errorType,
      errorMessage: details.message,
      ...(details.stack === undefined ? {} : { errorStack: details.stack }),
      attempts,
      firstFailedAt: now,
      lastFailedAt: now,
    });
    deadLettered({ kind: "process", subscriber: process.name, errorType });
    logger.warn("process dead-lettered", {
      process: process.name,
      eventId: event.id,
      errorType,
      attempts,
    });
  };

  const start = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instance: ProcessInstance,
  ): Promise<ProcessInstance> => {
    const context = contextOf(event);
    await append(
      process,
      event.aggregateId,
      instance,
      PROCESS_EVENTS.started,
      { state: process.initialState, eventId: event.id },
      context,
    );
    await storage.scheduler.schedule({
      dedupeKey: timeoutKey(process, event.aggregateId),
      command: {
        type: PROCESS_TIMEOUT_COMMAND,
        aggregateId: event.aggregateId,
        payload: {
          process: process.name,
          aggregateId: event.aggregateId,
        } satisfies ProcessTimeoutPayload,
      },
      executeAt: new Date(clock.now().getTime() + process.timeoutMs),
      context,
    });
    return { ...instance, exists: true, version: instance.version + 1 };
  };

  const handle = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instance: ProcessInstance,
  ): Promise<Outcome> => {
    const handler = process.handlers[event.type];
    if (handler === undefined || instance.handledEventIds.has(event.id)) return "done";
    const settings = config.forAggregate(process.aggregate).processes;
    const key = { subscriber: process.name, eventId: event.id };
    const now = clock.now();
    const existing = await storage.inboxLedger.get(key);
    if (existing?.status === "succeeded") return "done";
    if (existing?.status === "failed") {
      const waitMs = retryDelayMs({ retry: settings.retry, attempt: existing.attempts });
      if (now.getTime() - new Date(existing.claimedAt).getTime() < waitMs) return "hold";
    }
    if (
      !(await storage.inboxLedger.tryClaim({
        ...key,
        now,
        leaseMs: config.forAggregate(process.aggregate).policies.timeoutMs * 2,
      }))
    ) {
      return "done";
    }
    const context = contextOf(event);
    try {
      const next = await runHandler(process, event, instance, (existing?.attempts ?? 0) + 1);
      const state = next === undefined ? instance.state : (next as object);
      await append(
        process,
        event.aggregateId,
        instance,
        PROCESS_EVENTS.handled,
        { state, eventId: event.id, eventType: event.type },
        context,
      );
      await storage.inboxLedger.complete(key);
      return "done";
    } catch (error) {
      const attempts = (existing?.attempts ?? 0) + 1;
      const kind = error instanceof ConcurrencyError ? "retriable" : classifyFailure(error);
      if (kind === "terminal") {
        await append(
          process,
          event.aggregateId,
          instance,
          PROCESS_EVENTS.failed,
          { eventId: event.id, error: errorDetails(error).message },
          context,
        );
        await storage.scheduler.cancel(timeoutKey(process, event.aggregateId));
        await deadLetter(process, event, error, attempts, "terminal");
        await storage.inboxLedger.complete(key);
        return "done";
      }
      await storage.inboxLedger.fail({ ...key, error: errorDetails(error).message });
      if (attempts >= settings.retry.maxAttempts || settings.retry.strategy === "none") {
        await append(
          process,
          event.aggregateId,
          instance,
          PROCESS_EVENTS.failed,
          { eventId: event.id, error: errorDetails(error).message },
          context,
        );
        await storage.scheduler.cancel(timeoutKey(process, event.aggregateId));
        await deadLetter(process, event, error, attempts, "retriable_exhausted");
        await storage.inboxLedger.complete(key);
        return "done";
      }
      logger.warn("process handler failed; will retry", {
        process: process.name,
        eventId: event.id,
        attempts,
      });
      return "hold";
    }
  };

  const runHandler = (
    process: ProcessRuntime,
    event: StoredEvent,
    instance: ProcessInstance,
    attempt: number,
  ): Promise<unknown> =>
    traced({
      name: `bounda.process ${process.name}`,
      attributes: {
        [ATTRIBUTES.process]: process.name,
        [ATTRIBUTES.eventId]: event.id,
        [ATTRIBUTES.eventType]: event.type,
        [ATTRIBUTES.aggregateType]: event.aggregateType,
        [ATTRIBUTES.aggregateId]: event.aggregateId,
        [ATTRIBUTES.correlationId]: event.metadata.correlationId,
        [ATTRIBUTES.attempt]: attempt,
      },
      run: () =>
        withTimeout({
          run: () =>
            process.handlers[event.type]?.({
              event,
              state: instance.state,
              aggregateId: event.aggregateId,
              commands: facadeFor(contextOf(event)),
            }),
          timeoutMs: config.forAggregate(process.aggregate).policies.timeoutMs,
          subject: `process ${process.name}`,
        }),
    });

  const completeIfDue = async (process: ProcessRuntime, event: StoredEvent): Promise<void> => {
    if (!process.completedBy.has(event.type)) return;
    const current = await load(process, event.aggregateId);
    if (current.status !== "started") return;
    await append(
      process,
      event.aggregateId,
      current,
      PROCESS_EVENTS.completed,
      { eventId: event.id },
      contextOf(event),
    );
    await storage.scheduler.cancel(timeoutKey(process, event.aggregateId));
  };

  const deliver = async (process: ProcessRuntime, event: StoredEvent): Promise<Outcome> => {
    let instance = await load(process, event.aggregateId);
    if (!instance.exists) {
      if (!process.startedBy.has(event.type)) return "done";
      instance = await start(process, event, instance);
    }
    if (instance.status !== "started") return "done";
    const outcome = await handle(process, event, instance);
    if (outcome === "hold") return "hold";
    await completeIfDue(process, event);
    return "done";
  };

  const replay = async ({ process: name, event }: ReplayProcessArgs): Promise<void> => {
    const process = processes.byName[name];
    if (process === undefined) {
      throw new ConfigurationError(`Process "${name}" is no longer in the registry`);
    }
    const handler = process.handlers[event.type];
    if (handler === undefined) {
      throw new ConfigurationError(`Process "${name}" no longer handles ${event.type}`);
    }
    const instance = await load(process, event.aggregateId);
    if (!instance.exists) {
      throw new NotFoundError(`Process "${name}" has no instance for ${event.aggregateId}`);
    }
    const context = contextOf(event);
    const next = await runHandler(process, event, instance, 1);
    await append(
      process,
      event.aggregateId,
      instance,
      PROCESS_EVENTS.handled,
      {
        state: next === undefined ? instance.state : (next as object),
        eventId: event.id,
        eventType: event.type,
      },
      context,
    );
    if (instance.status === "failed") {
      const deadline =
        new Date(instance.startedAt ?? event.timestamp).getTime() + process.timeoutMs;
      await storage.scheduler.schedule({
        dedupeKey: timeoutKey(process, event.aggregateId),
        command: {
          type: PROCESS_TIMEOUT_COMMAND,
          aggregateId: event.aggregateId,
          payload: {
            process: process.name,
            aggregateId: event.aggregateId,
          } satisfies ProcessTimeoutPayload,
        },
        executeAt: new Date(Math.max(deadline, clock.now().getTime())),
        context,
      });
    }
    await completeIfDue(process, event);
    logger.info("process handler replayed", { process: process.name, eventId: event.id });
  };

  return {
    name: PROCESSES_SUBSCRIBER,
    kind: "process",
    process: async (events) => {
      let hold = false;
      for (const event of events) {
        for (const process of processes.byEvent[event.type] ?? []) {
          try {
            hold = (await deliver(process, event)) === "hold" || hold;
          } catch (error) {
            if (!(error instanceof ConcurrencyError)) throw error;
            logger.debug("process stream moved; will redeliver", {
              process: process.name,
              eventId: event.id,
            });
            hold = true;
          }
        }
      }
      return !hold;
    },
    replay,
    handleTimeout: async ({ payload, context }) => {
      const process = processes.byName[payload.process];
      if (process === undefined) return;
      const instance = await load(process, payload.aggregateId);
      if (!instance.exists || instance.status !== "started") return;
      const next =
        process.timeoutHandler === null
          ? instance.state
          : await traced({
              name: `bounda.process ${process.name} timeout`,
              attributes: {
                [ATTRIBUTES.process]: process.name,
                [ATTRIBUTES.aggregateType]: process.aggregate,
                [ATTRIBUTES.aggregateId]: payload.aggregateId,
                [ATTRIBUTES.correlationId]: context.correlationId,
              },
              run: () =>
                withTimeout({
                  run: () =>
                    process.timeoutHandler?.({
                      state: instance.state,
                      aggregateId: payload.aggregateId,
                      commands: facadeFor(context),
                    }),
                  timeoutMs: config.forAggregate(process.aggregate).policies.timeoutMs,
                  subject: `process ${process.name} timeout`,
                }),
            });
      await append(
        process,
        payload.aggregateId,
        instance,
        PROCESS_EVENTS.timedOut,
        { state: next ?? instance.state },
        context,
      );
    },
  };
};
