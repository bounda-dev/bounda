import type { StoragePorts } from "../../adapter/adapter.ts";
import type { DeadLetter } from "../../adapter/ports/dead-letter-store.ts";
import type { ResolvedConfig, ResolvedRetryConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import {
  ConcurrencyError,
  ConfigurationError,
  NotFoundError,
  ValidationError,
} from "../../contracts/errors.ts";
import { type StoredEvent, streamId } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { createCommandsFacade } from "../command/facade.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import { createReactionCommandIds, deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "../shared/retry.ts";
import { withTimeout } from "../shared/timeout.ts";
import { ATTRIBUTES, deadLettered, traced } from "../telemetry.ts";
import type { ProcessesRuntime, ProcessRuntime } from "./build-processes.ts";
import {
  afterFrom,
  type Deadline,
  nextDeadline,
  reachedKey,
  TIMEOUT_DEADLINE,
} from "./deadlines.ts";
import {
  foldProcess,
  type ParkedEvent,
  PROCESS_EVENTS,
  type ProcessInstance,
  processAggregateType,
} from "./lifecycle.ts";

export const PROCESSES_SUBSCRIBER: "processes" = "processes";

/**
 * The command type the scheduler holds for the next deadline of a process instance. Routed to the
 * process runner, never to a user command handler.
 */
export const PROCESS_DEADLINE_COMMAND: "bounda.ProcessDeadline" = "bounda.ProcessDeadline";

/**
 * What the scheduler holds for a process instance. `field` and `at` say which deadline the entry
 * was scheduled for; the runner works out which one is due from the instance when it runs.
 */
export interface ProcessDeadlinePayload {
  readonly process: string;
  readonly aggregateId: string;
  readonly field: string;
  readonly at: string;
}

export interface HandleDeadlineArgs {
  readonly payload: Pick<ProcessDeadlinePayload, "process" | "aggregateId">;
  readonly context: CausationContext;
  /**
   * Set when an operator replays a deadline from the dead letters: the handler runs for a process
   * that failed on it, and its `idempotencyKey` is new.
   */
  readonly replay?: string | undefined;
}

export interface FailDeadlineArgs {
  readonly payload: Pick<ProcessDeadlinePayload, "process" | "aggregateId">;
  readonly error: unknown;
  readonly attempts: number;
  readonly errorType: "terminal" | "retriable_exhausted";
}

export interface ReplayProcessArgs {
  /**
   * The process name as a dead letter records it, e.g. `order.orderPayment`.
   */
  readonly process: string;
  readonly event: StoredEvent;
  /**
   * Identifies this replay, so the handler's `idempotencyKey` differs from the failed run's.
   */
  readonly replay: string;
}

export interface ProcessRunner extends Subscriber {
  /**
   * Called by the scheduled-command worker when the entry of an instance comes due: runs the
   * handler of the earliest deadline that is due and records `ProcessDeadlineReached`, or
   * `ProcessTimedOut` for the timeout, then schedules the next one. When nothing is due, it only
   * schedules the next one.
   */
  handleDeadline(args: HandleDeadlineArgs): Promise<void>;
  /**
   * How a failed deadline of the process is retried: as its event handlers are.
   */
  retryOf(process: string): ResolvedRetryConfig;
  /**
   * Whether a deadline failed because another write to its instance's stream got there first:
   * worth running again at once, without counting an attempt. A conflict on any other stream,
   * such as one a command of the handler met, is an ordinary failure.
   */
  lostRace(
    payload: Pick<ProcessDeadlinePayload, "process" | "aggregateId">,
    error: unknown,
  ): boolean;
  /**
   * Called by the scheduled-command worker when a deadline entry gave up with `error`: records
   * `ProcessFailed` and dead-letters the deadline whose handler threw it, so a replay runs it again.
   * An error thrown outside a deadline handler fails no process. Either way the instance's entry
   * is written again, since the worker has dropped it.
   */
  failDeadline(args: FailDeadlineArgs): Promise<void>;
  /**
   * Runs a process handler again for an event whose earlier run was dead-lettered, ignoring the
   * inbox ledger. On success the instance gets its `ProcessHandled`, and an event that completes
   * the process completes it. A process that had failed then handles, in order, the events parked
   * behind the failure, and is back to `started` with its deadlines scheduled again once none is
   * left; one that fails again fails the process and is dead-lettered, and the rest stay parked.
   */
  replay(args: ReplayProcessArgs): Promise<void>;
  /**
   * How many events wait behind a process dead letter: those parked on its instance while the
   * failure it records keeps the instance failed. `0` for any other letter.
   */
  parkedBehind(letter: DeadLetter): Promise<number>;
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

const deadlineKey = (process: string, aggregateId: string): string =>
  `process-deadline:${process}:${aggregateId}`;

/**
 * Runs processes as internal aggregates: each instance is a stream of lifecycle events under
 * `process:<Type>:<aggregateId>`, appended with optimistic concurrency. An event that starts a
 * process writes `ProcessStarted` with the moment it times out; an event with a handler, the
 * starting one included, runs it and writes `ProcessHandled` with the new state; a completing
 * event writes `ProcessCompleted`. Failures follow the same rules as policies: terminal ones are
 * recorded as `ProcessFailed` and dead-lettered, retriable ones hold the checkpoint and are
 * retried with back-off through the inbox ledger.
 *
 * Deadlines are state: after every delivery to a running instance, and after every change the
 * runner makes to it, the instance's one scheduler entry is set to its earliest pending deadline,
 * or removed when there is none. The instance is read again after the entry is written, and the
 * write repeated if the stream moved meanwhile, so the last write always reflects the latest
 * state.
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
    id: string = ids.next(),
  ): Promise<void> => {
    const aggregateType = processAggregateType(process.type);
    await storage.eventStore.append({
      aggregateType,
      aggregateId,
      expectedVersion: instance.version,
      events: [
        {
          id,
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

  const facadeFor = (context: CausationContext, idempotencyKey: string) =>
    createCommandsFacade({
      aggregates,
      pipeline,
      context,
      commandIds: createReactionCommandIds(idempotencyKey),
    });

  const handlerArgs = (
    process: ProcessRuntime,
    context: CausationContext,
    idempotencyKey: string,
    triggeredAt: string,
  ): Record<string, unknown> => ({
    ...process.collaborators,
    commands: facadeFor(context, idempotencyKey),
    idempotencyKey,
    after: afterFrom(triggeredAt),
  });

  const entryContext = (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
  ): CausationContext => ({
    correlationId: instance.correlationId ?? instanceId,
    causationId: `${processAggregateType(process.type)}:${instanceId}`,
    depth: 0,
  });

  const pendingOf = (process: ProcessRuntime, instance: ProcessInstance): Deadline | null =>
    nextDeadline({
      fields: process.deadlineFields,
      state: instance.state,
      timeoutAt: instance.timeoutAt,
      reached: instance.reached,
    });

  const reconcile = async (process: ProcessRuntime, instanceId: string): Promise<void> => {
    const dedupeKey = deadlineKey(process.name, instanceId);
    let instance = await load(process, instanceId);
    for (;;) {
      const next = instance.status === "started" ? pendingOf(process, instance) : null;
      if (next === null) {
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
          context: entryContext(process, instanceId, instance),
          keepTimingOfSameCommand: true,
        });
      }
      const current = await load(process, instanceId);
      if (current.version === instance.version) return;
      instance = current;
    }
  };

  const validState = (process: ProcessRuntime, state: unknown): object => {
    if (process.stateSchema === null) return state as object;
    const parsed = process.stateSchema.safeParse(state);
    if (parsed.success) return parsed.data as object;
    throw new ValidationError(
      `Process ${process.name} returned a state its schema refuses`,
      parsed.error.issues.map((issue) => ({
        path: issue.path.filter(
          (segment): segment is string | number => typeof segment !== "symbol",
        ),
        message: issue.message,
      })),
    );
  };

  const deadLetter = async (
    process: ProcessRuntime,
    subject: Pick<StoredEvent, "id" | "type" | "aggregateType" | "aggregateId">,
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
      eventId: subject.id,
      eventType: subject.type,
      aggregateType: subject.aggregateType,
      aggregateId: subject.aggregateId,
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
      eventId: subject.id,
      errorType,
      attempts,
    });
  };

  const start = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    instance: ProcessInstance,
  ): Promise<ProcessInstance> => {
    const context = contextOf(event);
    const timeoutAt = new Date(Date.parse(event.timestamp) + process.timeoutMs).toISOString();
    await append(
      process,
      instanceId,
      instance,
      PROCESS_EVENTS.started,
      { state: process.initialState, eventId: event.id, timeoutAt },
      context,
    );
    return {
      ...instance,
      exists: true,
      version: instance.version + 1,
      timeoutAt,
      correlationId: context.correlationId,
    };
  };

  const handle = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    instance: ProcessInstance,
  ): Promise<Outcome> => {
    const handler = process.handlers[qualifiedEventType(event.aggregateType, event.type)];
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
      return "hold";
    }
    const context = contextOf(event);
    try {
      const state = await runHandler(
        process,
        event,
        instanceId,
        instance,
        (existing?.attempts ?? 0) + 1,
      );
      await append(
        process,
        instanceId,
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
          instanceId,
          instance,
          PROCESS_EVENTS.failed,
          { eventId: event.id, error: errorDetails(error).message },
          context,
        );
        await deadLetter(process, event, error, attempts, "terminal");
        await storage.inboxLedger.complete(key);
        return "done";
      }
      await storage.inboxLedger.fail({ ...key, error: errorDetails(error).message });
      if (attempts >= settings.retry.maxAttempts || settings.retry.strategy === "none") {
        await append(
          process,
          instanceId,
          instance,
          PROCESS_EVENTS.failed,
          { eventId: event.id, error: errorDetails(error).message },
          context,
        );
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

  const runHandler = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    instance: ProcessInstance,
    attempt: number,
    replay?: string,
  ): Promise<object> => {
    const next = await traced({
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
            process.handlers[qualifiedEventType(event.aggregateType, event.type)]?.({
              ...handlerArgs(
                process,
                contextOf(event),
                deriveIdempotencyKey({
                  kind: "process",
                  handler: process.name,
                  subject: event.id,
                  replay,
                }),
                event.timestamp,
              ),
              event,
              state: instance.state,
              aggregateId: instanceId,
            }),
          timeoutMs: config.forAggregate(process.aggregate).policies.timeoutMs,
          subject: `process ${process.name}`,
          clock,
        }),
    });
    return validState(process, next === undefined ? instance.state : next);
  };

  const completeIfDue = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    resuming = false,
  ): Promise<void> => {
    if (!process.completedBy.has(qualifiedEventType(event.aggregateType, event.type))) return;
    const current = await load(process, instanceId);
    if (current.status !== "started" && !(resuming && current.status === "failed")) return;
    await append(
      process,
      instanceId,
      current,
      PROCESS_EVENTS.completed,
      { eventId: event.id },
      contextOf(event),
    );
  };

  const uncorrelated = async (
    process: ProcessRuntime,
    event: StoredEvent,
    error: unknown,
  ): Promise<Outcome> => {
    const key = { subscriber: process.name, eventId: event.id };
    if ((await storage.inboxLedger.get(key))?.status === "succeeded") return "done";
    const claimed = await storage.inboxLedger.tryClaim({
      ...key,
      now: clock.now(),
      leaseMs: config.forAggregate(process.aggregate).policies.timeoutMs * 2,
    });
    if (!claimed) return "hold";
    await deadLetter(process, event, error, 1, "terminal");
    await storage.inboxLedger.complete(key);
    return "done";
  };

  const park = async (
    process: ProcessRuntime,
    event: StoredEvent,
    instanceId: string,
    instance: ProcessInstance,
  ): Promise<void> => {
    const qualified = qualifiedEventType(event.aggregateType, event.type);
    const acts = process.handlers[qualified] !== undefined || process.completedBy.has(qualified);
    if (
      !acts ||
      event.id === instance.failure?.eventId ||
      instance.handledEventIds.has(event.id) ||
      instance.parked.some((parked) => parked.eventId === event.id)
    ) {
      return;
    }
    await append(
      process,
      instanceId,
      instance,
      PROCESS_EVENTS.eventParked,
      {
        eventId: event.id,
        eventType: event.type,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
      } satisfies ParkedEvent,
      contextOf(event),
    );
    logger.info("process event parked behind a failure", {
      process: process.name,
      aggregateId: instanceId,
      eventId: event.id,
    });
  };

  const parkedEvent = async (parked: ParkedEvent): Promise<StoredEvent> => {
    const { events } = await storage.eventStore.load({
      aggregateType: parked.aggregateType,
      aggregateId: parked.aggregateId,
    });
    const event = events.find((candidate) => candidate.id === parked.eventId);
    if (event === undefined) {
      throw new NotFoundError(
        `Parked event ${parked.eventId} of ${parked.aggregateType}:${parked.aggregateId} not found`,
      );
    }
    return event;
  };

  const handleParked = async (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    event: StoredEvent,
  ): Promise<boolean> => {
    const qualified = qualifiedEventType(event.aggregateType, event.type);
    if (process.handlers[qualified] === undefined && !process.completedBy.has(qualified)) {
      logger.warn("process no longer acts on a parked event; it is let through", {
        process: process.name,
        aggregateId: instanceId,
        eventId: event.id,
      });
      await append(
        process,
        instanceId,
        instance,
        PROCESS_EVENTS.handled,
        { state: instance.state, eventId: event.id, eventType: event.type },
        contextOf(event),
      );
      return true;
    }
    if (process.handlers[qualified] !== undefined) {
      try {
        const state = await runHandler(process, event, instanceId, instance, 1);
        await append(
          process,
          instanceId,
          instance,
          PROCESS_EVENTS.handled,
          { state, eventId: event.id, eventType: event.type },
          contextOf(event),
        );
      } catch (error) {
        if (lostRace(process, instanceId, error)) return true;
        await append(
          process,
          instanceId,
          await load(process, instanceId),
          PROCESS_EVENTS.failed,
          { eventId: event.id, error: errorDetails(error).message },
          contextOf(event),
        );
        await deadLetter(
          process,
          event,
          error,
          1,
          classifyFailure(error) === "terminal" ? "terminal" : "retriable_exhausted",
        );
        return false;
      }
    }
    await completeIfDue(process, event, instanceId, true);
    return true;
  };

  const resumeParked = async (process: ProcessRuntime, instanceId: string): Promise<void> => {
    for (;;) {
      const instance = await load(process, instanceId);
      if (instance.status !== "failed") return;
      const [next] = instance.parked;
      if (next === undefined) {
        try {
          await append(
            process,
            instanceId,
            instance,
            PROCESS_EVENTS.resumed,
            {},
            entryContext(process, instanceId, instance),
          );
          logger.info("process resumed", { process: process.name, aggregateId: instanceId });
          return;
        } catch (error) {
          if (!lostRace(process, instanceId, error)) throw error;
          continue;
        }
      }
      if (!(await handleParked(process, instanceId, instance, await parkedEvent(next)))) return;
    }
  };

  const deliver = async (process: ProcessRuntime, event: StoredEvent): Promise<Outcome> => {
    let instanceId: string | null;
    try {
      instanceId = process.instanceOf(event);
    } catch (error) {
      return uncorrelated(process, event, error);
    }
    if (instanceId === null) return "done";
    let instance = await load(process, instanceId);
    if (!instance.exists) {
      if (!process.startedBy.has(qualifiedEventType(event.aggregateType, event.type))) {
        return "done";
      }
      instance = await start(process, event, instanceId, instance);
    }
    if (instance.status === "failed") {
      await park(process, event, instanceId, instance);
      return "done";
    }
    if (instance.status !== "started") return "done";
    const outcome = await handle(process, event, instanceId, instance);
    if (outcome === "done") await completeIfDue(process, event, instanceId);
    await reconcile(process, instanceId);
    return outcome;
  };

  const replay = async ({ process: name, event, replay }: ReplayProcessArgs): Promise<void> => {
    const process = processes.byName[name];
    if (process === undefined) {
      throw new ConfigurationError(`Process "${name}" is no longer in the registry`);
    }
    const handler = process.handlers[qualifiedEventType(event.aggregateType, event.type)];
    if (handler === undefined) {
      throw new ConfigurationError(`Process "${name}" no longer handles ${event.type}`);
    }
    const instanceId = process.instanceOf(event);
    const instance = instanceId === null ? null : await load(process, instanceId);
    if (instanceId === null || instance === null || !instance.exists) {
      throw new NotFoundError(
        `Process "${name}" has no instance for ${event.aggregateType}:${event.aggregateId}`,
      );
    }
    if (instance.status === "failed" && instance.failure?.eventId !== event.id) {
      throw new ConfigurationError(
        `Process "${name}" is failed on another step for ${instanceId}; replay the dead letter of that failure first`,
      );
    }
    if (!instance.handledEventIds.has(event.id)) {
      const state = await runHandler(process, event, instanceId, instance, 1, replay);
      await append(
        process,
        instanceId,
        instance,
        PROCESS_EVENTS.handled,
        { state, eventId: event.id, eventType: event.type },
        contextOf(event),
      );
    }
    await completeIfDue(process, event, instanceId, true);
    await resumeParked(process, instanceId);
    await reconcile(process, instanceId);
    logger.info("process handler replayed", { process: process.name, eventId: event.id });
  };

  const runDeadline = async (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    due: Deadline,
    context: CausationContext,
    replay: string | undefined,
  ): Promise<void> => {
    const reachedId = ids.next();
    const handler = process.deadlineHandlers[due.field];
    const returned =
      handler === undefined
        ? instance.state
        : await traced({
            name: `bounda.process ${process.name} at ${due.field}`,
            attributes: {
              [ATTRIBUTES.process]: process.name,
              [ATTRIBUTES.aggregateType]: process.aggregate,
              [ATTRIBUTES.aggregateId]: instanceId,
              [ATTRIBUTES.correlationId]: context.correlationId,
            },
            run: () =>
              withTimeout({
                run: () =>
                  handler({
                    ...handlerArgs(
                      process,
                      { correlationId: context.correlationId, causationId: reachedId, depth: 0 },
                      deriveIdempotencyKey({
                        kind: "process",
                        handler: process.name,
                        subject: `${instanceId}:deadline:${due.field}:${new Date(due.at).toISOString()}`,
                        replay,
                      }),
                      due.at,
                    ),
                    state: instance.state,
                    aggregateId: instanceId,
                  }),
                timeoutMs: config.forAggregate(process.aggregate).policies.timeoutMs,
                subject: `process ${process.name} at ${due.field}`,
                clock,
              }),
          });
    const state = validState(process, returned ?? instance.state);
    if (due.field === TIMEOUT_DEADLINE) {
      await append(
        process,
        instanceId,
        instance,
        PROCESS_EVENTS.timedOut,
        { state },
        context,
        reachedId,
      );
      return;
    }
    const kept = (state as Readonly<Record<string, unknown>>)[due.field];
    if (Date.parse(String(kept)) === Date.parse(due.at)) {
      throw new ValidationError(
        `Process ${process.name} left the deadline "${due.field}" at the moment that came due`,
        [{ path: [due.field], message: "Set it to null, or to another moment with after()" }],
      );
    }
    await append(
      process,
      instanceId,
      instance,
      PROCESS_EVENTS.deadlineReached,
      { field: due.field, at: due.at, state },
      context,
      reachedId,
    );
  };

  const failedDeadlines = new WeakMap<object, Deadline>();

  const attemptDeadline = async (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    due: Deadline,
    context: CausationContext,
    replay: string | undefined,
  ): Promise<void> => {
    try {
      await runDeadline(process, instanceId, instance, due, context, replay);
    } catch (error) {
      const thrown = typeof error === "object" && error !== null ? error : new Error(String(error));
      failedDeadlines.set(thrown, due);
      throw thrown;
    }
  };

  const handleDeadline = async ({
    payload,
    context,
    replay,
  }: HandleDeadlineArgs): Promise<void> => {
    const process = processes.byName[payload.process];
    if (process === undefined) {
      if (replay !== undefined) {
        throw new ConfigurationError(`Process "${payload.process}" is no longer in the registry`);
      }
      await storage.scheduler.cancel(deadlineKey(payload.process, payload.aggregateId));
      return;
    }
    const instance = await load(process, payload.aggregateId);
    const due = pendingOf(process, instance);
    if (replay !== undefined) {
      const failed = instance.failure?.deadline;
      if (instance.status !== "failed" || failed === undefined) {
        throw new NotFoundError(
          `Process "${process.name}" has no failed deadline for ${payload.aggregateId}`,
        );
      }
      if (!instance.reached.has(reachedKey(failed))) {
        await attemptDeadline(
          process,
          payload.aggregateId,
          instance,
          failed,
          { ...context, correlationId: instance.correlationId ?? context.correlationId },
          replay,
        );
      }
      await resumeParked(process, payload.aggregateId);
    } else if (
      instance.status === "started" &&
      due !== null &&
      Date.parse(due.at) <= clock.now().getTime()
    ) {
      await attemptDeadline(process, payload.aggregateId, instance, due, context, replay);
    }
    await reconcile(process, payload.aggregateId);
  };

  const lostRace = (process: ProcessRuntime, aggregateId: string, error: unknown): boolean =>
    error instanceof ConcurrencyError &&
    error.streamId === streamId({ aggregateType: processAggregateType(process.type), aggregateId });

  const failDeadline = async ({
    payload,
    error,
    attempts,
    errorType,
  }: FailDeadlineArgs): Promise<void> => {
    const process = processes.byName[payload.process];
    if (process === undefined) {
      await storage.scheduler.cancel(deadlineKey(payload.process, payload.aggregateId));
      return;
    }
    const failed =
      typeof error === "object" && error !== null ? failedDeadlines.get(error) : undefined;
    for (;;) {
      const instance = await load(process, payload.aggregateId);
      if (
        failed === undefined ||
        instance.status !== "started" ||
        instance.reached.has(reachedKey(failed))
      ) {
        logger.warn("process deadline gave up without failing the process", {
          process: process.name,
          aggregateId: payload.aggregateId,
          status: instance.status,
          thrownBy: failed?.field ?? null,
          error: errorDetails(error).message,
        });
        await reconcile(process, payload.aggregateId);
        return;
      }
      try {
        await append(
          process,
          payload.aggregateId,
          instance,
          PROCESS_EVENTS.failed,
          { deadline: failed.field, at: failed.at, error: errorDetails(error).message },
          entryContext(process, payload.aggregateId, instance),
        );
        break;
      } catch (appendError) {
        if (!lostRace(process, payload.aggregateId, appendError)) throw appendError;
      }
    }
    await reconcile(process, payload.aggregateId);
    await deadLetter(
      process,
      {
        id: `deadline:${failed.field}`,
        type: PROCESS_DEADLINE_COMMAND,
        aggregateType: processAggregateType(process.type),
        aggregateId: payload.aggregateId,
      },
      error,
      attempts,
      errorType,
    );
  };

  return {
    name: PROCESSES_SUBSCRIBER,
    kind: "process",
    process: async (events) => {
      let hold = false;
      for (const event of events) {
        const qualified = qualifiedEventType(event.aggregateType, event.type);
        for (const process of processes.byEvent[qualified] ?? []) {
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
    handleDeadline,
    failDeadline,
    parkedBehind: async (letter) => {
      const process = processes.byName[letter.subscriber];
      if (letter.kind !== "process" || letter.status !== "failed" || process === undefined) {
        return 0;
      }
      const instanceId =
        letter.eventType === PROCESS_DEADLINE_COMMAND
          ? letter.aggregateId
          : await parkedEvent({
              eventId: letter.eventId,
              eventType: letter.eventType,
              aggregateType: letter.aggregateType,
              aggregateId: letter.aggregateId,
            })
              .then((event) => process.instanceOf(event))
              .catch(() => null);
      if (instanceId === null) return 0;
      const instance = await load(process, instanceId);
      return instance.status === "failed"
        ? instance.parked.filter((parked) => parked.eventId !== instance.failure?.eventId).length
        : 0;
    },
    lostRace: (payload, error) => {
      const process = processes.byName[payload.process];
      return process !== undefined && lostRace(process, payload.aggregateId, error);
    },
    retryOf: (name) => {
      const process = processes.byName[name];
      return process === undefined
        ? config.runtime.processes.retry
        : config.forAggregate(process.aggregate).processes.retry;
    },
  };
};
