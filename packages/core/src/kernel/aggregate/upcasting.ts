import type { EventStore } from "../../adapter/ports/event-store.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
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
  (args: UpcastEventArgs): StoredEvent;
}

/**
 * Brings one stored event to the current shape of its type: the upcasts from its
 * `schemaVersion` on are applied to the payload and the metadata says the version they produce.
 * Events of unknown aggregates or types, system events and events already current come back as
 * they are. An event written with a version this code does not know is refused: newer code
 * wrote it, and this process must not fold a payload it cannot read.
 */
export const upcastEvent: UpcastEventFunction = ({ event, aggregates }) => {
  const runtime = aggregates.byName[event.aggregateType]?.eventsByType[event.type];
  if (runtime === undefined || event.metadata.system) return event;
  const from = event.metadata.schemaVersion;
  if (from > runtime.schemaVersion) {
    throw new ConfigurationError(
      `Event ${event.id} (${event.type} of ${event.aggregateType}:${event.aggregateId}) was written with schema version ${from}, but this code knows ${runtime.schemaVersion}. Deploy the code that wrote it`,
    );
  }
  if (from === runtime.schemaVersion) return event;
  let payload: unknown = event.payload;
  for (const upcast of runtime.upcasts.slice(from - 1)) {
    payload = (upcast as (payload: unknown) => unknown)(payload);
  }
  return {
    ...event,
    payload,
    metadata: { ...event.metadata, schemaVersion: runtime.schemaVersion },
  };
};

/**
 * The event store as the kernel reads it: every event that comes out of `load` and `readAll` is
 * upcast to the shape its type has today, so `apply`, policies, processes and projections only
 * ever see current payloads. Writes pass through untouched; the pipeline stamps them with the
 * current version.
 */
export const withUpcasting: WithUpcastingFunction = ({ eventStore, aggregates }) => {
  const current = (event: StoredEvent): StoredEvent => upcastEvent({ event, aggregates });
  return {
    append: (args) => eventStore.append(args),
    load: async (args) => {
      const loaded = await eventStore.load(args);
      return { ...loaded, events: loaded.events.map(current) };
    },
    readAll: async (args) => (await eventStore.readAll(args)).map(current),
    lastPosition: () => eventStore.lastPosition(),
  };
};
