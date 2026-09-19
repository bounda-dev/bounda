import type { EventStore } from "../adapter/ports/event-store.ts";
import { ConcurrencyError } from "../contracts/errors.ts";
import type { StoredEvent } from "../contracts/event.ts";
import { streamId } from "../contracts/event.ts";

export interface CreateMemoryEventStoreFunction {
  (): EventStore;
}

/**
 * An event store held in memory. Appends are atomic because nothing yields between the version
 * check and the write.
 */
export const createMemoryEventStore: CreateMemoryEventStoreFunction = () => {
  const streams = new Map<string, StoredEvent[]>();
  const global: StoredEvent[] = [];

  return {
    append: async ({ aggregateType, aggregateId, expectedVersion, events }) => {
      const key = streamId({ aggregateType, aggregateId });
      const stream = streams.get(key) ?? [];
      const actualVersion = stream.length;
      if (actualVersion !== expectedVersion) {
        throw new ConcurrencyError({ streamId: key, expectedVersion, actualVersion });
      }
      const stored = events.map((event, index) => ({
        ...event,
        position: global.length + index + 1,
      }));
      streams.set(key, [...stream, ...stored]);
      global.push(...stored);
      return { version: actualVersion + stored.length, events: stored };
    },
    load: async ({ aggregateType, aggregateId, fromVersion = 1 }) => {
      const stream = streams.get(streamId({ aggregateType, aggregateId })) ?? [];
      return {
        events: stream.filter((event) => event.version >= fromVersion),
        version: stream.length,
      };
    },
    readAll: async ({ afterPosition, limit }) => global.slice(afterPosition, afterPosition + limit),
    lastPosition: async () => global.length,
  };
};
