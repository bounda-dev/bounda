import type { EventStore } from "../../adapter/storage/event-store.ts";
import { ConfigurationError, SchemaAheadError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { carryOpening } from "../personal-data/event-store.ts";
import type { AggregatesRuntime } from "./runtime.ts";

export interface WithUpcastingArgs {
  readonly eventStore: EventStore;
  readonly aggregates: AggregatesRuntime;
}

export interface WithUpcastingFunction {
  (args: WithUpcastingArgs): EventStore;
}

export interface UpcastEventArgs {
  readonly event: StoredEvent;
  readonly aggregates: AggregatesRuntime;
}

export interface UpcastEventFunction {
  (args: UpcastEventArgs): StoredEvent | null;
}

/**
 * `null` for an event no module of this code reads: its aggregate or its type is unknown. An event
 * written with a version past the one this code knows throws `SchemaAheadError`: newer code wrote
 * it, and this process must not fold a payload it cannot read. System events pass as they are.
 */
export const upcastEvent: UpcastEventFunction = ({ event, aggregates }) => {
  if (event.metadata.system) return event;
  const runtime = aggregates.byName[event.aggregateType]?.eventsByType[event.type];
  if (runtime === undefined) return null;
  const from = event.metadata.schemaVersion;
  if (from > runtime.schemaVersion) throw schemaAhead(event, runtime.schemaVersion);
  if (from === runtime.schemaVersion) return event;
  let payload: unknown = event.payload;
  for (const upcast of runtime.upcasts.slice(from - 1)) {
    payload = (upcast as (payload: unknown) => unknown)(payload);
  }
  return carryOpening(event, {
    ...event,
    payload,
    metadata: { ...event.metadata, schemaVersion: runtime.schemaVersion },
  });
};

const schemaAhead = (event: StoredEvent, known: number | null): SchemaAheadError =>
  new SchemaAheadError({
    eventId: event.id,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    type: event.type,
    position: event.position,
    schemaVersion: event.metadata.schemaVersion,
    known,
  });

type Read =
  | { readonly event: StoredEvent }
  | { readonly refused: SchemaAheadError | { readonly unknown: StoredEvent } };

/**
 * So `evolve`, policies, processes and projections only ever see current payloads. Writes pass
 * through untouched, since the pipeline stamps them with the current version.
 *
 * An event this code cannot read stops every read that reaches it. Its type unknown, the store's
 * catalogue tells newer code, which recorded it after the boot checked the catalogue, from a
 * writer that never recorded it. `readAll` hands out the events before it, so subscribers behind
 * it catch up to it, and throws only when it comes first.
 */
export const withUpcasting: WithUpcastingFunction = ({ eventStore, aggregates }) => {
  const read = (event: StoredEvent): Read => {
    try {
      const current = upcastEvent({ event, aggregates });
      return current === null ? { refused: { unknown: event } } : { event: current };
    } catch (error) {
      if (error instanceof SchemaAheadError) return { refused: error };
      throw error;
    }
  };
  const refusal = async (refused: SchemaAheadError | { readonly unknown: StoredEvent }) => {
    if (refused instanceof SchemaAheadError) return refused;
    const event = refused.unknown;
    const recorded = (await eventStore.types()).some(
      ({ aggregateType, type, schemaVersion }) =>
        aggregateType === event.aggregateType &&
        type === event.type &&
        schemaVersion === event.metadata.schemaVersion,
    );
    if (recorded) return schemaAhead(event, null);
    return new ConfigurationError(
      `Event ${event.id} (${event.aggregateType}.${event.type} of ${event.aggregateType}:${event.aggregateId}) has no event module in this code, and no Bounda writer recorded its type. Restore the module that wrote it`,
    );
  };
  const readable = async (event: StoredEvent): Promise<StoredEvent> => {
    const result = read(event);
    if ("event" in result) return result.event;
    throw await refusal(result.refused);
  };
  return {
    append: (args) => eventStore.append(args),
    load: async (args) => {
      const loaded = await eventStore.load(args);
      const events: StoredEvent[] = [];
      for (const event of loaded.events) events.push(await readable(event));
      return { ...loaded, events };
    },
    readOne: async (args) => {
      const event = await eventStore.readOne(args);
      return event === null ? null : readable(event);
    },
    readAll: async (args) => {
      const events: StoredEvent[] = [];
      for (const event of await eventStore.readAll(args)) {
        const result = read(event);
        if ("event" in result) {
          events.push(result.event);
          continue;
        }
        if (events.length > 0) return events;
        throw await refusal(result.refused);
      }
      return events;
    },
    // An export cannot be partial.
    readByPerson: async (args) => {
      const events: StoredEvent[] = [];
      for (const event of await eventStore.readByPerson(args)) events.push(await readable(event));
      return events;
    },
    lastPosition: () => eventStore.lastPosition(),
    types: () => eventStore.types(),
  };
};
