import type { StoredEvent } from "../../contracts/event.ts";

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
  readonly completed: "ProcessCompleted";
  readonly timedOut: "ProcessTimedOut";
  readonly failed: "ProcessFailed";
} = {
  started: "ProcessStarted",
  handled: "ProcessHandled",
  completed: "ProcessCompleted",
  timedOut: "ProcessTimedOut",
  failed: "ProcessFailed",
};

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
   * When the process started, from its `ProcessStarted` event; `null` for an instance that does
   * not exist. What a replay measures the original deadline from.
   */
  readonly startedAt: string | null;
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
 * Rebuilds a process instance from its lifecycle events. A `ProcessHandled` after a
 * `ProcessFailed` is what a replayed dead letter writes, and it puts the process back to
 * `started`.
 */
export const foldProcess: FoldProcessFunction = ({ initialState, events }) => {
  const handled = new Set<string>();
  let status: ProcessStatus = "started";
  let state = initialState;
  let startedAt: string | null = null;
  for (const event of events) {
    switch (event.type) {
      case PROCESS_EVENTS.started:
        state = stateOf(event, state);
        startedAt = event.timestamp;
        break;
      case PROCESS_EVENTS.handled: {
        state = stateOf(event, state);
        if (status === "failed") status = "started";
        const payload = event.payload as { readonly eventId?: string };
        if (payload.eventId !== undefined) handled.add(payload.eventId);
        break;
      }
      case PROCESS_EVENTS.completed:
        status = "completed";
        break;
      case PROCESS_EVENTS.timedOut:
        state = stateOf(event, state);
        status = "timed_out";
        break;
      case PROCESS_EVENTS.failed:
        status = "failed";
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
    startedAt,
  };
};
