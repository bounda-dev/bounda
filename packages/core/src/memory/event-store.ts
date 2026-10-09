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

// An event as a SQL store keeps it: payload and metadata as JSON text, so each read is a fresh
// copy and holds what JSON holds, as the SQL stores hand them out.
interface Kept extends Omit<StoredEvent, "payload" | "metadata"> {
  readonly payload: string | undefined;
  readonly metadata: string;
}

const keep = ({ payload, metadata, ...rest }: StoredEvent): Kept => ({
  ...rest,
  payload: payload === undefined ? undefined : JSON.stringify(payload),
  metadata: JSON.stringify(metadata),
});

const restore = ({ payload, metadata, ...rest }: Kept): StoredEvent => ({
  ...rest,
  payload: payload === undefined ? undefined : JSON.parse(payload),
  metadata: JSON.parse(metadata),
});

/**
 * An event store held in memory. Appends are atomic because nothing yields between the version
 * check and the write.
 */
export const createMemoryEventStore: CreateMemoryEventStoreFunction = ({ onAppend } = {}) => {
  const streams = new Map<string, Kept[]>();
  const global: Kept[] = [];

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
    // Every batch is kept before any is written, so one that JSON refuses appends nothing.
    let position = global.length;
    const appended = batches.map(({ events }) =>
      events.map((event) => {
        position += 1;
        return { event: { ...event, position }, kept: keep({ ...event, position }) };
      }),
    );
    const results = batches.map(({ aggregateType, aggregateId, expectedVersion }, index) => {
      const key = streamId({ aggregateType, aggregateId });
      const batch = appended[index] ?? [];
      const kept = batch.map((entry) => entry.kept);
      streams.set(key, [...(streams.get(key) ?? []), ...kept]);
      global.push(...kept);
      return { version: expectedVersion + batch.length, events: batch.map((entry) => entry.event) };
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
        events: stream.filter((event) => event.version >= fromVersion).map(restore),
        version: stream.length,
      };
    },
    readAll: async ({ afterPosition, limit }) =>
      global.slice(afterPosition, afterPosition + limit).map(restore),
    lastPosition: async () => global.length,
  };
};
