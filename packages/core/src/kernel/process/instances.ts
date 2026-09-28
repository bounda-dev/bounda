import type { StoragePorts } from "../../adapter/adapter.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConcurrencyError, NotFoundError } from "../../contracts/errors.ts";
import { type StoredEvent, streamId } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import {
  foldProcess,
  type LifecycleEntry,
  type ParkedEvent,
  PROCESS_EVENTS,
  type ProcessInstance,
  processAggregateType,
} from "./lifecycle.ts";

/**
 * The streams of process instances, `process:<Type>:<aggregateId>`: folded on read, appended with
 * optimistic concurrency on the version they were folded at.
 */
export interface ProcessInstances {
  load(process: ProcessRuntime, instanceId: string): Promise<ProcessInstance>;
  append(
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    entries: readonly LifecycleEntry[],
  ): Promise<void>;
  /**
   * Appends `entries` past the events parked on the instance since it was folded; any other write
   * to the stream meanwhile still fails it.
   */
  appendPastParks(
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    entries: readonly LifecycleEntry[],
  ): Promise<void>;
  /**
   * Whether `error` is another write to the instance's stream getting there first.
   */
  lostRace(process: ProcessRuntime, instanceId: string, error: unknown): boolean;
  /**
   * Loads the event a `ProcessEventParked` points at, from its own aggregate's stream.
   */
  parkedEvent(parked: ParkedEvent): Promise<StoredEvent>;
}

export interface CreateProcessInstancesArgs {
  readonly storage: StoragePorts;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface CreateProcessInstancesFunction {
  (args: CreateProcessInstancesArgs): ProcessInstances;
}

export const createProcessInstances: CreateProcessInstancesFunction = ({ storage, ids, clock }) => {
  const load = async (process: ProcessRuntime, instanceId: string): Promise<ProcessInstance> => {
    const loaded = await storage.eventStore.load({
      aggregateType: processAggregateType(process.type),
      aggregateId: instanceId,
    });
    return foldProcess({ initialState: process.initialState, events: loaded.events });
  };

  const append = async (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    entries: readonly LifecycleEntry[],
  ): Promise<void> => {
    const aggregateType = processAggregateType(process.type);
    await storage.eventStore.append({
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
      streamId({ aggregateType: processAggregateType(process.type), aggregateId: instanceId });

  const appendPastParks = async (
    process: ProcessRuntime,
    instanceId: string,
    instance: ProcessInstance,
    entries: readonly LifecycleEntry[],
  ): Promise<void> => {
    let current = instance;
    for (;;) {
      try {
        await append(process, instanceId, current, entries);
        return;
      } catch (error) {
        if (!lostRace(process, instanceId, error)) throw error;
        const loaded = await storage.eventStore.load({
          aggregateType: processAggregateType(process.type),
          aggregateId: instanceId,
        });
        const since = loaded.events.slice(current.version);
        if (
          since.length === 0 ||
          !since.every((event) => event.type === PROCESS_EVENTS.eventParked)
        ) {
          throw error;
        }
        current = foldProcess({ initialState: process.initialState, events: loaded.events });
      }
    }
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

  return { load, append, appendPastParks, lostRace, parkedEvent };
};
