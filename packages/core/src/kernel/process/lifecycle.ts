import type { NewDeadLetter } from "../../adapter/ports/dead-letter-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { reachedKey } from "./deadlines.ts";

/**
 * Status of a process instance, derived from its lifecycle events.
 */
export type ProcessStatus = "started" | "completed" | "failed" | "timed_out";

/**
 * The lifecycle event types a process stream holds. They are system events: replayable, visible,
 * never fed to aggregate `apply` functions.
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
 * An event that reached a failed process instance and waits, in its stream, until the failure is
 * replayed: where to load it from.
 */
export interface ParkedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
}

/**
 * The stream prefix of process instances: `process:OrderPayment` for the process `OrderPayment`.
 */
export interface ProcessAggregateTypeFunction {
  (processType: string): string;
}

export const processAggregateType: ProcessAggregateTypeFunction = (processType) =>
  `process:${processType}`;

/**
 * A process instance as folded from its stream. `version` is the stream version, used for
 * optimistic concurrency on the next lifecycle append. `handledEventIds` holds the events whose
 * handler already ran; the starting event is among them only if it has a handler of its own.
 */
export interface ProcessInstance {
  readonly exists: boolean;
  readonly status: ProcessStatus;
  readonly state: object;
  readonly version: number;
  readonly handledEventIds: ReadonlySet<string>;
  /**
   * When the process times out, from its `ProcessStarted` event; `null` for an instance that does
   * not exist.
   */
  readonly timeoutAt: string | null;
  /**
   * The deadlines the instance has reached, as `reachedKey` writes them: each field comes due once
   * at each moment.
   */
  readonly reached: ReadonlySet<string>;
  /**
   * The correlation id of the event that started the process, which its deadlines carry on.
   */
  readonly correlationId: string | null;
  /**
   * The events parked while the instance was failed and not handled since, oldest first.
   */
  readonly parked: readonly ParkedEvent[];
  /**
   * What the last `ProcessFailed` failed on: an event, or a deadline at its moment. `null` for an
   * instance that never failed.
   */
  readonly failure: ProcessFailure | null;
}

/**
 * What a process failed on, as its `ProcessFailed` records it.
 */
export interface ProcessFailure {
  readonly eventId?: string;
  readonly deadline?: { readonly field: string; readonly at: string };
  /**
   * The dead letter that records the failure, as `ProcessFailed` carries it, so the letter can be
   * filed again when writing it was cut short.
   */
  readonly letter?: NewDeadLetter;
}

export interface FoldProcessArgs {
  readonly initialState: object;
  readonly events: readonly StoredEvent[];
}

export interface FoldProcessFunction {
  (args: FoldProcessArgs): ProcessInstance;
}

const stateOf = (event: StoredEvent, fallback: object): object => {
  const payload = event.payload as { readonly state?: object };
  return payload.state ?? fallback;
};

/**
 * Rebuilds a process instance from its lifecycle events. A failed instance stays failed until
 * `ProcessResumed`, which replaying its failure writes once the events parked behind it are
 * handled; a `ProcessHandled` takes its event off the parked ones.
 */
export const foldProcess: FoldProcessFunction = ({ initialState, events }) => {
  const handled = new Set<string>();
  const reached = new Set<string>();
  const parked = new Map<string, ParkedEvent>();
  let failure: ProcessFailure | null = null;
  let status: ProcessStatus = "started";
  let state = initialState;
  let timeoutAt: string | null = null;
  let correlationId: string | null = null;
  for (const event of events) {
    switch (event.type) {
      case PROCESS_EVENTS.started: {
        state = stateOf(event, state);
        timeoutAt = (event.payload as { readonly timeoutAt?: string }).timeoutAt ?? null;
        correlationId = event.metadata.correlationId;
        break;
      }
      case PROCESS_EVENTS.handled: {
        state = stateOf(event, state);
        const payload = event.payload as { readonly eventId?: string };
        if (payload.eventId !== undefined) {
          handled.add(payload.eventId);
          parked.delete(payload.eventId);
        }
        break;
      }
      case PROCESS_EVENTS.deadlineReached: {
        state = stateOf(event, state);
        reached.add(reachedKey(event.payload as { readonly field: string; readonly at: string }));
        break;
      }
      case PROCESS_EVENTS.completed:
        status = "completed";
        break;
      case PROCESS_EVENTS.timedOut:
        state = stateOf(event, state);
        status = "timed_out";
        break;
      case PROCESS_EVENTS.failed: {
        status = "failed";
        const payload = event.payload as {
          readonly eventId?: string;
          readonly deadline?: string;
          readonly at?: string;
          readonly letter?: NewDeadLetter;
        };
        failure = {
          ...(payload.eventId === undefined ? {} : { eventId: payload.eventId }),
          ...(payload.letter === undefined ? {} : { letter: payload.letter }),
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
    parked: [...parked.values()],
    failure,
  };
};
