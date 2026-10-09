import type { EventStore } from "../../adapter/ports/event-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConcurrencyError, NotFoundError } from "../../contracts/errors.ts";
import { type StoredEvent, streamId } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import {
  foldProcess,
  type LifecycleEntry,
  type ParkedEvent,
  type ProcessInstance,
  processAggregateType,
} from "./lifecycle.ts";

/**
 * The streams `process:<aggregate>.<process>:<instanceId>`, appended at the version the instance
 * was folded at.
 */
export interface ProcessInstances {
  load(process: ProcessRuntime, instanceId: string): Promise<ProcessInstance>;
  /**
   * Appends after `instance`, which must come from this view's `load`: an instance loaded through
   * another view carries a version this one never fixed, and a stream that moved meanwhile would
   * fail here, as the handler's own failure, instead of at the commit, where the step runs again.
   */
  append(
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    entries: readonly LifecycleEntry[],
  ): Promise<void>;
  /**
   * Whether `error` is another write to the instance's stream getting there first.
   */
  lostRace(process: ProcessRuntime, instanceId: string, error: unknown): boolean;
  parkedEvent(parked: ParkedEvent): Promise<StoredEvent>;
}

export interface CreateProcessInstancesArgs {
  /**
   * Where the instance streams live: the storage's event store, or a unit of work's view of it.
   */
  readonly eventStore: EventStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface CreateProcessInstancesFunction {
  (args: CreateProcessInstancesArgs): ProcessInstances;
}

export const createProcessInstances: CreateProcessInstancesFunction = ({
  eventStore,
  ids,
  clock,
}) => {
  const loaded = new Set<string>();

  const load = async (process: ProcessRuntime, instanceId: string): Promise<ProcessInstance> => {
    const stream = { aggregateType: processAggregateType(process.name), aggregateId: instanceId };
    const { events } = await eventStore.load(stream);
    loaded.add(streamId(stream));
    return foldProcess({
      initialState: process.initialState,
      deadlineFields: process.deadlineFields,
      events,
    });
  };

  const append = async (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    entries: readonly LifecycleEntry[],
  ): Promise<void> => {
    const aggregateType = processAggregateType(process.name);
    if (!loaded.has(streamId({ aggregateType, aggregateId: instanceId }))) {
      throw new Error(
        `Process ${process.name} appended to ${instanceId} without loading it through the same view`,
      );
    }
    await eventStore.append({
      aggregateType,
      aggregateId: instanceId,
      expectedVersion: instance.version,
      events: entries.map((entry, index) => ({
        id: entry.id ?? ids.next(),
        aggregateType,
        aggregateId: instanceId,
        version: instance.version + index + 1,
        type: entry.type,
        payload: entry.payload,
        timestamp: clock.now().toISOString(),
        metadata: { ...entry.context, schemaVersion: 1, system: true },
      })),
    });
  };

  const lostRace = (process: ProcessRuntime, instanceId: string, error: unknown): boolean =>
    error instanceof ConcurrencyError &&
    error.streamId ===
      streamId({ aggregateType: processAggregateType(process.name), aggregateId: instanceId });

  const parkedEvent = async (parked: ParkedEvent): Promise<StoredEvent> => {
    const { events } = await eventStore.load({
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

  return { load, append, lostRace, parkedEvent };
};
