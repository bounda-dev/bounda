import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { type LifecycleEntry, lifecycleEntries, type ProcessInstance } from "./lifecycle.ts";

type EventHandler = ProcessRuntime["handlers"][string];

// What routing reads of an event: a decided one that is not stored yet routes as it will.
type RoutedEvent = Pick<StoredEvent, "aggregateType" | "type">;

export interface HandlerOfFunction {
  (process: ProcessRuntime, event: RoutedEvent): EventHandler | undefined;
}

export const handlerOf: HandlerOfFunction = (process, event) =>
  process.handlers[qualifiedEventType(event.aggregateType, event.type)];

export interface EventRouteFunction {
  (process: ProcessRuntime, event: RoutedEvent): boolean;
}

export const startsOn: EventRouteFunction = (process, event) =>
  process.startedBy.has(qualifiedEventType(event.aggregateType, event.type));

export const completesOn: EventRouteFunction = (process, event) =>
  process.completedBy.has(qualifiedEventType(event.aggregateType, event.type));

/**
 * Whether `event` does anything to a running instance: runs a handler or completes it.
 */
export const actsOn: EventRouteFunction = (process, event) =>
  handlerOf(process, event) !== undefined || completesOn(process, event);

export interface PendingFollowUpFunction {
  (instance: ProcessInstance, event: StoredEvent): boolean;
}

/**
 * Whether `event` is one the `at-timeout` of an instance that timed out caused, not handled yet.
 */
export const pendingFollowUp: PendingFollowUpFunction = (instance, event) =>
  instance.followUps.has(event.id);

export interface FollowsUpFunction {
  (process: ProcessRuntime, instance: ProcessInstance, event: StoredEvent): boolean;
}

/**
 * Whether `event` still reaches an instance that timed out: a pending follow-up the process still
 * has a handler for.
 */
export const followsUp: FollowsUpFunction = (process, instance, event) =>
  pendingFollowUp(instance, event) && handlerOf(process, event) !== undefined;

export interface HandledEntriesFunction {
  (
    process: ProcessRuntime,
    instance: ProcessInstance,
    event: StoredEvent,
    state: object,
  ): LifecycleEntry[];
}

/**
 * A follow-up of a timed-out instance never completes it: the instance has ended already.
 */
export const handledEntries: HandledEntriesFunction = (process, instance, event, state) => [
  lifecycleEntries.handled(event, state),
  ...(completesOn(process, event) && instance.status !== "timed_out"
    ? [lifecycleEntries.completed(event)]
    : []),
];

export interface LetThroughFunction {
  (process: ProcessRuntime, instanceId: string, event: StoredEvent, logger: Logger): void;
}

/**
 * Warns that an event the instance waited for is handled without anything to run: the process
 * no longer acts on it.
 */
export const letThrough: LetThroughFunction = (process, instanceId, event, logger) => {
  logger.warn("process no longer acts on an event it waited for; it is let through", {
    process: process.name,
    aggregateId: instanceId,
    eventId: event.id,
  });
};
