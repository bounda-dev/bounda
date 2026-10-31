import { ConcurrencyError } from "../contracts/errors.ts";
import { type StoredEvent, streamId } from "../contracts/event.ts";
import type { AppendArgs, EventStore } from "./storage/event-store.ts";

/**
 * An event store that keeps what is appended to it aside: `load` answers with the base store's
 * events plus the ones staged for that stream, `append` stages with the version the stream has
 * in that view, and `readAll` and `lastPosition` read the base store alone, since staged events
 * are not written yet. `batches` hands out what to append at commit, one batch per stream, each
 * expecting the version the stream had in the base store when the view first met it.
 */
export interface StagedEventStore extends EventStore {
  batches(): readonly StagedBatch[];
}

/**
 * A batch to append at commit, with the position each of its events was staged with: what
 * `nextPosition` gave, or 0.
 */
export interface StagedBatch extends AppendArgs {
  readonly positions: readonly number[];
}

export interface CreateStagedEventStoreArgs {
  /**
   * Reserves the position a staged event will have once committed, for a base store that can
   * hold one; without it, staged events answer with position 0.
   */
  readonly nextPosition?: () => number;
}

export interface CreateStagedEventStoreFunction {
  (base: EventStore, args?: CreateStagedEventStoreArgs): StagedEventStore;
}

interface StagedStream {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly base: number;
  readonly events: StoredEvent[];
  readonly persons: Set<string>;
}

export const createStagedEventStore: CreateStagedEventStoreFunction = (
  base,
  { nextPosition = () => 0 } = {},
) => {
  const streams = new Map<string, StagedStream>();

  const stagedFor = async (aggregateType: string, aggregateId: string): Promise<StagedStream> => {
    const key = streamId({ aggregateType, aggregateId });
    const existing = streams.get(key);
    if (existing !== undefined) return existing;
    // Only the version is wanted: from past any head, a load reads no event and the SQL stores
    // count instead of scanning.
    const { version } = await base.load({
      aggregateType,
      aggregateId,
      fromVersion: Number.MAX_SAFE_INTEGER,
    });
    const created = {
      aggregateType,
      aggregateId,
      base: version,
      events: [],
      persons: new Set<string>(),
    };
    streams.set(key, created);
    return created;
  };

  return {
    load: async ({ aggregateType, aggregateId, fromVersion = 1 }) => {
      const stored = await base.load({ aggregateType, aggregateId, fromVersion });
      const key = streamId({ aggregateType, aggregateId });
      const staged =
        streams.get(key) ??
        (() => {
          const created = {
            aggregateType,
            aggregateId,
            base: stored.version,
            events: [],
            persons: new Set<string>(),
          };
          streams.set(key, created);
          return created;
        })();
      return {
        events: [
          ...stored.events.filter((event) => event.version <= staged.base),
          ...staged.events.filter((event) => event.version >= fromVersion),
        ],
        version: staged.base + staged.events.length,
      };
    },
    append: async ({ aggregateType, aggregateId, expectedVersion, events, persons = [] }) => {
      const staged = await stagedFor(aggregateType, aggregateId);
      const actualVersion = staged.base + staged.events.length;
      if (actualVersion !== expectedVersion) {
        throw new ConcurrencyError({
          streamId: streamId({ aggregateType, aggregateId }),
          expectedVersion,
          actualVersion,
        });
      }
      const stored = events.map((event) => ({ ...event, position: nextPosition() }));
      staged.events.push(...stored);
      for (const person of persons) staged.persons.add(person);
      return { version: actualVersion + stored.length, events: stored };
    },
    readAll: (args) => base.readAll(args),
    lastPosition: () => base.lastPosition(),
    batches: () =>
      [...streams.values()]
        .filter((staged) => staged.events.length > 0)
        .map(({ aggregateType, aggregateId, base: expectedVersion, events, persons }) => ({
          aggregateType,
          aggregateId,
          expectedVersion,
          events: events.map(({ position: _position, ...event }) => event),
          persons: [...persons],
          positions: events.map((event) => event.position),
        })),
  };
};
