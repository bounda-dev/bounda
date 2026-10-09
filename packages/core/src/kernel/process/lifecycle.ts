import type { NewDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { type Deadline, deadlineAt, reachedKey, TIMEOUT_DEADLINE } from "./deadlines.ts";

/**
 * Status of a process instance, derived from its lifecycle events.
 */
export type ProcessStatus = "started" | "completed" | "failed" | "timed_out";

/**
 * The lifecycle event types a process stream holds. They are system events: replayable, visible,
 * never fed to aggregate `evolve` functions.
 */
export const PROCESS_EVENTS: {
  readonly started: "ProcessStarted";
  readonly handled: "ProcessHandled";
  readonly deadlineReached: "ProcessDeadlineReached";
  readonly completed: "ProcessCompleted";
  readonly timedOut: "ProcessTimedOut";
  readonly failed: "ProcessFailed";
  readonly eventParked: "ProcessEventParked";
  readonly resumed: "ProcessResumed";
} = {
  started: "ProcessStarted",
  handled: "ProcessHandled",
  deadlineReached: "ProcessDeadlineReached",
  completed: "ProcessCompleted",
  timedOut: "ProcessTimedOut",
  failed: "ProcessFailed",
  eventParked: "ProcessEventParked",
  resumed: "ProcessResumed",
};

/**
 * Where to load an event parked on a failed instance until its failure is retried.
 */
export interface ParkedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
}

/**
 * The stream prefix of process instances: `process:order.orderPayment` for the process
 * `orderPayment` of the aggregate `order`. Qualified by the aggregate, as every other key of a
 * process is, so two aggregates' processes of the same name never share an instance's stream.
 */
export interface ProcessAggregateTypeFunction {
  (processName: string): string;
}

export const processAggregateType: ProcessAggregateTypeFunction = (processName) =>
  `process:${processName}`;

export interface ProcessInstance {
  readonly exists: boolean;
  readonly status: ProcessStatus;
  readonly state: object;
  readonly version: number;
  /**
   * The events whose handler already ran; the starting event only if it has a handler of its own.
   */
  readonly handledEventIds: ReadonlySet<string>;
  /**
   * From its `ProcessStarted`; `null` for an instance that does not exist.
   */
  readonly timeoutAt: string | null;
  /**
   * The deadlines the instance has reached, as `reachedKey` writes them: each field comes due once
   * at each moment.
   */
  readonly reached: ReadonlySet<string>;
  /**
   * The correlation id of the event that started the process, carried on by what the runner
   * writes for the instance with no event to point at, such as a resume.
   */
  readonly correlationId: string | null;
  /**
   * What reaching each deadline is caused by, by `reachedKey`: the lifecycle event whose step set
   * the field to that moment, `ProcessStarted` for the timeout. A step that leaves the moment as it
   * was is not its cause.
   */
  readonly deadlineCauses: ReadonlyMap<string, DeadlineCause>;
  /**
   * The events parked while the instance was failed and not handled since, oldest first.
   */
  readonly parked: readonly ParkedEvent[];
  /**
   * The events its `at-timeout` caused that a handler of the process takes and that it has not
   * handled yet: they still reach a `timed_out` instance.
   */
  readonly followUps: ReadonlySet<string>;
  /**
   * What the last `ProcessFailed` failed on: an event, or a deadline at its moment. `null` for an
   * instance that never failed.
   */
  readonly failure: ProcessFailure | null;
}

export interface ProcessFailure {
  readonly eventId?: string;
  readonly deadline?: { readonly field: string; readonly at: string };
  /**
   * The dead letter that records the failure, committed with it.
   */
  readonly letterId?: string;
}

export type DeadlineCause = Pick<CausationContext, "correlationId" | "causationId">;

export interface FoldProcessArgs {
  readonly initialState: object;
  readonly deadlineFields: readonly string[];
  readonly events: readonly StoredEvent[];
}

export interface FoldProcessFunction {
  (args: FoldProcessArgs): ProcessInstance;
}

const stateOf = (event: StoredEvent, fallback: object): object => {
  const payload = event.payload as { readonly state?: object };
  return payload.state ?? fallback;
};

const causeOf = (event: StoredEvent): DeadlineCause => ({
  correlationId: event.metadata.correlationId,
  causationId: event.id,
});

/**
 * A failed instance stays failed until `ProcessResumed`; a `ProcessHandled` takes its event off
 * the parked ones.
 */
export const foldProcess: FoldProcessFunction = ({ initialState, deadlineFields, events }) => {
  const handled = new Set<string>();
  const reached = new Set<string>();
  const parked = new Map<string, ParkedEvent>();
  const followUps = new Set<string>();
  let failure: ProcessFailure | null = null;
  let status: ProcessStatus = "started";
  let state = initialState;
  let timeoutAt: string | null = null;
  let correlationId: string | null = null;
  const deadlineCauses = new Map<string, DeadlineCause>();
  const moments = new Map<string, string>();
  const evolve = (event: StoredEvent): void => {
    state = stateOf(event, state);
    for (const field of deadlineFields) {
      const at = deadlineAt(state, field);
      if (at === null) {
        moments.delete(field);
        continue;
      }
      const key = reachedKey({ field, at });
      if (moments.get(field) !== key) {
        moments.set(field, key);
        deadlineCauses.set(key, causeOf(event));
      }
    }
  };
  for (const event of events) {
    switch (event.type) {
      case PROCESS_EVENTS.started: {
        evolve(event);
        timeoutAt = (event.payload as { readonly timeoutAt?: string }).timeoutAt ?? null;
        if (timeoutAt !== null) {
          deadlineCauses.set(
            reachedKey({ field: TIMEOUT_DEADLINE, at: timeoutAt }),
            causeOf(event),
          );
        }
        correlationId = event.metadata.correlationId;
        break;
      }
      case PROCESS_EVENTS.handled: {
        evolve(event);
        const payload = event.payload as { readonly eventId?: string };
        if (payload.eventId !== undefined) {
          handled.add(payload.eventId);
          parked.delete(payload.eventId);
          followUps.delete(payload.eventId);
        }
        break;
      }
      case PROCESS_EVENTS.deadlineReached: {
        evolve(event);
        reached.add(reachedKey(event.payload as { readonly field: string; readonly at: string }));
        break;
      }
      case PROCESS_EVENTS.completed:
        status = "completed";
        break;
      case PROCESS_EVENTS.timedOut: {
        evolve(event);
        status = "timed_out";
        const payload = event.payload as { readonly followUps?: readonly string[] };
        for (const eventId of payload.followUps ?? []) followUps.add(eventId);
        break;
      }
      case PROCESS_EVENTS.failed: {
        status = "failed";
        const payload = event.payload as {
          readonly eventId?: string;
          readonly deadline?: string;
          readonly at?: string;
          readonly letterId?: string;
        };
        failure = {
          ...(payload.eventId === undefined ? {} : { eventId: payload.eventId }),
          ...(payload.letterId === undefined ? {} : { letterId: payload.letterId }),
          ...(payload.deadline === undefined || payload.at === undefined
            ? {}
            : { deadline: { field: payload.deadline, at: payload.at } }),
        };
        break;
      }
      case PROCESS_EVENTS.eventParked: {
        const payload = event.payload as ParkedEvent;
        parked.set(payload.eventId, {
          eventId: payload.eventId,
          eventType: payload.eventType,
          aggregateType: payload.aggregateType,
          aggregateId: payload.aggregateId,
        });
        break;
      }
      case PROCESS_EVENTS.resumed:
        if (status === "failed") status = "started";
        break;
      default:
        break;
    }
  }
  return {
    exists: events.length > 0,
    status,
    state,
    version: events.length,
    handledEventIds: handled,
    timeoutAt,
    reached,
    correlationId,
    deadlineCauses,
    parked: [...parked.values()],
    followUps,
    failure,
  };
};

export interface LifecycleEntry {
  readonly type: string;
  readonly payload: unknown;
  readonly context: CausationContext;
  /**
   * Set when something the event causes must name it before it is written.
   */
  readonly id?: string;
}

export interface EventContextFunction {
  (event: StoredEvent): CausationContext;
}

export const eventContext: EventContextFunction = (event) => ({
  correlationId: event.metadata.correlationId,
  causationId: event.id,
  depth: event.metadata.depth,
});

export interface InstanceContextFunction {
  (process: ProcessRuntime, instanceId: string, instance: ProcessInstance): CausationContext;
}

/**
 * For what the runner writes on its own for an instance with no event to point at, such as a
 * resume or a failed deadline.
 */
export const instanceContext: InstanceContextFunction = (process, instanceId, instance) => ({
  correlationId: instance.correlationId ?? instanceId,
  causationId: `${processAggregateType(process.name)}:${instanceId}`,
  depth: 0,
});

export interface DeadlineContextFunction {
  (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    due: Deadline,
  ): CausationContext;
}

/**
 * For reaching a deadline: under the correlation and caused by the lifecycle event that set it, as
 * a scheduled command is by what scheduled it. Its depth starts again, so a deadline set again at
 * every step never reaches `maxChainDepth`.
 */
export const deadlineContext: DeadlineContextFunction = (process, instanceId, instance, due) => {
  const cause = instance.deadlineCauses.get(reachedKey(due));
  return cause === undefined
    ? instanceContext(process, instanceId, instance)
    : { ...cause, depth: 0 };
};

export type FailedOn =
  | { readonly eventId: string }
  | { readonly deadline: string; readonly at: string };

/**
 * Builds the lifecycle events the runner writes, in the shapes `foldProcess` reads.
 */
export interface LifecycleEntries {
  started(event: StoredEvent, state: object, timeoutAt: string): LifecycleEntry;
  handled(event: StoredEvent, state: object): LifecycleEntry;
  completed(event: StoredEvent): LifecycleEntry;
  failed(failedOn: FailedOn, letter: NewDeadLetter, context: CausationContext): LifecycleEntry;
  parked(event: StoredEvent): LifecycleEntry;
  resumed(context: CausationContext): LifecycleEntry;
  deadlineReached(
    due: Deadline,
    state: object,
    context: CausationContext,
    id: string,
  ): LifecycleEntry;
  timedOut(
    state: object,
    context: CausationContext,
    id: string,
    followUps: readonly string[],
  ): LifecycleEntry;
}

export const lifecycleEntries: LifecycleEntries = {
  started: (event, state, timeoutAt) => ({
    type: PROCESS_EVENTS.started,
    payload: { state, eventId: event.id, timeoutAt },
    context: eventContext(event),
  }),
  handled: (event, state) => ({
    type: PROCESS_EVENTS.handled,
    payload: { state, eventId: event.id, eventType: event.type },
    context: eventContext(event),
  }),
  completed: (event) => ({
    type: PROCESS_EVENTS.completed,
    payload: { eventId: event.id },
    context: eventContext(event),
  }),
  failed: (failedOn, letter, context) => ({
    type: PROCESS_EVENTS.failed,
    payload: { ...failedOn, error: letter.errorMessage, letterId: letter.id },
    context,
  }),
  parked: (event) => ({
    type: PROCESS_EVENTS.eventParked,
    payload: {
      eventId: event.id,
      eventType: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
    } satisfies ParkedEvent,
    context: eventContext(event),
  }),
  resumed: (context) => ({ type: PROCESS_EVENTS.resumed, payload: {}, context }),
  deadlineReached: (due, state, context, id) => ({
    type: PROCESS_EVENTS.deadlineReached,
    payload: { field: due.field, at: due.at, state },
    context,
    id,
  }),
  timedOut: (state, context, id, followUps) => ({
    type: PROCESS_EVENTS.timedOut,
    payload: followUps.length === 0 ? { state } : { state, followUps },
    context,
    id,
  }),
};
