import type { AppendArgs, AppendResult, EventStore } from "../adapter/ports/event-store.ts";
import { ConcurrencyError } from "../contracts/errors.ts";
import type { StoredEvent } from "../contracts/event.ts";
import { streamId } from "../contracts/event.ts";

export interface CreateMemoryEventStoreArgs {
  /**
   * Called after every append with the position of the last event stored.
   */
  readonly onAppend?: (position: number) => void;
}

/**
 * The in-memory event store, with `appendAll`: several batches appended in one synchronous run,
 * in order, every version checked before anything is written. What the memory adapter's
 * `transact` commits with.
 */
export interface MemoryEventStore extends EventStore {
  appendAll(batches: readonly AppendArgs[]): Promise<readonly AppendResult[]>;
}

export interface CreateMemoryEventStoreFunction {
  (args?: CreateMemoryEventStoreArgs): MemoryEventStore;
}

/**
 * An event store held in memory. Appends are atomic because nothing yields between the version
 * check and the write.
 */
export const createMemoryEventStore: CreateMemoryEventStoreFunction = ({ onAppend } = {}) => {
  const streams = new Map<string, StoredEvent[]>();
  const global: StoredEvent[] = [];

  const appendAll = async (batches: readonly AppendArgs[]): Promise<readonly AppendResult[]> => {
    const versions = new Map<string, number>();
    for (const { aggregateType, aggregateId, expectedVersion, events } of batches) {
      const key = streamId({ aggregateType, aggregateId });
      const actualVersion = versions.get(key) ?? streams.get(key)?.length ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new ConcurrencyError({ streamId: key, expectedVersion, actualVersion });
      }
      versions.set(key, actualVersion + events.length);
    }
    const results = batches.map(({ aggregateType, aggregateId, expectedVersion, events }) => {
      const key = streamId({ aggregateType, aggregateId });
      const stream = streams.get(key) ?? [];
      const stored = events.map((event, index) => ({
        ...event,
        position: global.length + index + 1,
      }));
      streams.set(key, [...stream, ...stored]);
      global.push(...stored);
      return { version: expectedVersion + stored.length, events: stored };
    });
    if (results.some((result) => result.events.length > 0)) onAppend?.(global.length);
    return results;
  };

  return {
    appendAll,
    append: async (args) => (await appendAll([args]))[0] as AppendResult,
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
