import type { AppendArgs, AppendResult, EventStore } from "../adapter/storage/event-store.ts";
import { ConcurrencyError } from "../contracts/errors.ts";
import type { StoredEvent } from "../contracts/event.ts";
import { streamId } from "../contracts/event.ts";
import { toJson } from "./json-copy.ts";

export interface CreateMemoryEventStoreArgs {
  // Receives the last position readers can see.
  readonly onAppend?: (position: number) => void;
}

/**
 * A batch to append whose events may already hold their positions, reserved while they were
 * staged; an event at 0, or a batch without `positions`, takes the next one when written.
 */
export interface PositionedAppendArgs extends AppendArgs {
  readonly positions?: readonly number[];
}

export interface MemoryEventStore extends EventStore {
  appendAll(batches: readonly PositionedAppendArgs[]): Promise<readonly AppendResult[]>;
  /**
   * Takes the next position for an event a transaction stages. Readers stop short of it until
   * the transaction writes it with `appendAll` or gives it back with `release`, so an event
   * written meanwhile at a later position never overtakes it.
   */
  reserve(): number;
  /**
   * Gives back positions a transaction reserved and will not write: the log's tail moves back
   * before them, and whatever is left among written events becomes a gap readers skip, as a
   * rolled-back sequence leaves on PostgreSQL.
   */
  release(positions: readonly number[]): void;
}

export interface CreateMemoryEventStoreFunction {
  (args?: CreateMemoryEventStoreArgs): MemoryEventStore;
}

// An event as a SQL store keeps it: payload and metadata as JSON text, so each read is a fresh
// copy and holds what JSON holds, as the SQL stores hand them out.
interface Kept extends Omit<StoredEvent, "payload" | "metadata"> {
  readonly payload: string;
  readonly metadata: string;
}

const keep = ({ payload, metadata, ...rest }: StoredEvent): Kept => ({
  ...rest,
  payload: toJson(payload),
  metadata: toJson(metadata),
});

const restore = ({ payload, metadata, ...rest }: Kept): StoredEvent => ({
  ...rest,
  payload: JSON.parse(payload),
  metadata: JSON.parse(metadata),
});

export const createMemoryEventStore: CreateMemoryEventStoreFunction = ({ onAppend } = {}) => {
  const streams = new Map<string, Kept[]>();
  const log = new Map<number, Kept>();
  const gaps = new Set<number>();
  let reserved = 0;
  // Every position up to here is written or a gap: what readers see.
  let watermark = 0;

  const advance = (): void => {
    const before = watermark;
    while (log.has(watermark + 1) || gaps.delete(watermark + 1)) watermark += 1;
    if (watermark > before) onAppend?.(watermark);
  };

  const reserve = (): number => {
    reserved += 1;
    return reserved;
  };

  // Atomic because nothing yields between the version checks and the writes.
  const appendAll = async (
    batches: readonly PositionedAppendArgs[],
  ): Promise<readonly AppendResult[]> => {
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
    const prepared = batches.map(
      ({ aggregateType, aggregateId, expectedVersion, events, positions }) => ({
        key: streamId({ aggregateType, aggregateId }),
        expectedVersion,
        events,
        positions,
        kept: events.map((event) => keep({ ...event, position: 0 })),
      }),
    );
    const results = prepared.map(({ key, expectedVersion, events, positions, kept }) => {
      const written = kept.map((event, index) => ({
        ...event,
        position: positions?.[index] || reserve(),
      }));
      streams.set(key, [...(streams.get(key) ?? []), ...written]);
      for (const event of written) log.set(event.position, event);
      return {
        version: expectedVersion + written.length,
        events: events.map((event, index) => ({
          ...event,
          position: written[index]?.position ?? 0,
        })),
      };
    });
    advance();
    return results;
  };

  return {
    appendAll,
    append: async (args) => (await appendAll([args]))[0] as AppendResult,
    reserve,
    release: (positions) => {
      for (const position of [...positions].sort((a, b) => b - a)) {
        if (position === reserved) reserved -= 1;
        else gaps.add(position);
      }
      advance();
    },
    load: async ({ aggregateType, aggregateId, fromVersion = 1 }) => {
      const stream = streams.get(streamId({ aggregateType, aggregateId })) ?? [];
      return {
        events: stream.filter((event) => event.version >= fromVersion).map(restore),
        version: stream.length,
      };
    },
    readAll: async ({ afterPosition, limit }) => {
      const events: StoredEvent[] = [];
      for (let at = afterPosition + 1; at <= watermark && events.length < limit; at += 1) {
        const kept = log.get(at);
        if (kept !== undefined) events.push(restore(kept));
      }
      return events;
    },
    lastPosition: async () => watermark,
  };
};
