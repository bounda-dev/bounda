import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { type LifecycleEntry, lifecycleEntries } from "./lifecycle.ts";

type EventHandler = ProcessRuntime["handlers"][string];

export interface HandlerOfFunction {
  (process: ProcessRuntime, event: StoredEvent): EventHandler | undefined;
}

export const handlerOf: HandlerOfFunction = (process, event) =>
  process.handlers[qualifiedEventType(event.aggregateType, event.type)];

export interface EventRouteFunction {
  (process: ProcessRuntime, event: StoredEvent): boolean;
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

export interface HandledEntriesFunction {
  (process: ProcessRuntime, event: StoredEvent, state: object): LifecycleEntry[];
}

export const handledEntries: HandledEntriesFunction = (process, event, state) => [
  lifecycleEntries.handled(event, state),
  ...(completesOn(process, event) ? [lifecycleEntries.completed(event)] : []),
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
