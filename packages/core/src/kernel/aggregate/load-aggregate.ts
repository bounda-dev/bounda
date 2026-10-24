import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { SnapshotStore } from "../../adapter/storage/snapshot-store.ts";
import { SnapshotError } from "../../contracts/errors.ts";
import type { StreamIdentity } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import { errorDetails } from "../shared/retry.ts";
import { ATTRIBUTES, METRICS, meter } from "../telemetry.ts";
import { type FoldedState, foldState } from "./fold-state.ts";
import type { AggregateRuntime } from "./runtime.ts";
import { deserializeFold, foldsEqual } from "./snapshot-codec.ts";

export interface LoadAggregateArgs {
  readonly aggregate: AggregateRuntime;
  readonly aggregateId: string;
  /**
   * The store to read from: the storage's, or a unit of work's with the events it staged.
   */
  readonly eventStore: EventStore;
}

export interface LoadedAggregate {
  readonly folded: FoldedState;
  /**
   * The stream's head, system events included: what an append expects.
   */
  readonly version: number;
}

/**
 * Loads an aggregate's state: from its snapshot when it takes them and the snapshot is valid,
 * from its first event otherwise. The loads of one aggregate share the verification sample.
 */
export interface AggregateLoader {
  load(args: LoadAggregateArgs): Promise<LoadedAggregate>;
}

export interface CreateAggregateLoaderArgs {
  readonly snapshotStore: SnapshotStore;
  readonly logger: Logger;
  /**
   * For an app from `createTestApp`: every load from a snapshot is checked, and one that folds
   * to a different state throws `SnapshotError` instead of being dropped.
   */
  readonly strict: boolean;
}

export interface CreateAggregateLoaderFunction {
  (args: CreateAggregateLoaderArgs): AggregateLoader;
}

/**
 * What a snapshot was worth to a load, as `bounda.snapshots` counts them. `used` and `verified`
 * both loaded from it; only the second compared the result with the whole stream.
 */
export type SnapshotOutcome =
  | "missing"
  | "stale"
  | "unreadable"
  | "ahead"
  | "used"
  | "verified"
  | "mismatch";

/**
 * A snapshot is used only when its fingerprint is the aggregate's, it reads back and the stream
 * reaches its version; otherwise the stream is folded from its first event, and one that read
 * badly or is past the stream's head is dropped. A verified load folds the whole stream up to
 * the version it loaded, so an append landing in between does not count as a difference.
 */
export const createAggregateLoader: CreateAggregateLoaderFunction = ({
  snapshotStore,
  logger,
  strict,
}) => {
  const counter = meter().createCounter(METRICS.snapshots, {
    description: "Loads of an aggregate with snapshots, by what its snapshot was worth",
    unit: "{load}",
  });
  // Credit per aggregate, so the share `verify` asks for is met exactly, not on average.
  const credits = new Map<string, number>();
  const due = (aggregate: AggregateRuntime, verify: number): boolean => {
    if (strict) return true;
    const credit = (credits.get(aggregate.name) ?? 0) + verify;
    credits.set(aggregate.name, credit >= 1 ? credit - 1 : credit);
    return credit >= 1;
  };
  const count = (aggregate: AggregateRuntime, outcome: SnapshotOutcome): void => {
    counter.add(1, { [ATTRIBUTES.aggregateType]: aggregate.name, [ATTRIBUTES.outcome]: outcome });
  };
  const fromStart = async (
    aggregate: AggregateRuntime,
    stream: StreamIdentity,
    eventStore: EventStore,
    through = Number.POSITIVE_INFINITY,
  ): Promise<LoadedAggregate> => {
    const loaded = await eventStore.load(stream);
    const events = loaded.events.filter((event) => event.version <= through);
    return {
      folded: foldState({ aggregate, events }),
      version: Math.min(loaded.version, through),
    };
  };
  const dropped = async (
    aggregate: AggregateRuntime,
    stream: StreamIdentity,
    eventStore: EventStore,
    outcome: SnapshotOutcome,
    message: string,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<LoadedAggregate> => {
    count(aggregate, outcome);
    logger.warn(message, { ...stream, ...fields });
    await snapshotStore.remove(stream);
    return fromStart(aggregate, stream, eventStore);
  };

  return {
    load: async ({ aggregate, aggregateId, eventStore }) => {
      const stream = { aggregateType: aggregate.name, aggregateId };
      const settings = aggregate.snapshot;
      if (settings === null) return fromStart(aggregate, stream, eventStore);
      const snapshot = await snapshotStore.get(stream);
      if (snapshot === null) {
        count(aggregate, "missing");
        return fromStart(aggregate, stream, eventStore);
      }
      if (snapshot.fingerprint !== settings.fingerprint) {
        count(aggregate, "stale");
        return fromStart(aggregate, stream, eventStore);
      }
      let from: FoldedState;
      try {
        from = deserializeFold(snapshot.state);
      } catch (error) {
        return dropped(
          aggregate,
          stream,
          eventStore,
          "unreadable",
          "snapshot could not be read; the stream is folded from its first event",
          { version: snapshot.version, ...errorDetails(error) },
        );
      }
      const loaded = await eventStore.load({ ...stream, fromVersion: snapshot.version + 1 });
      if (loaded.version < snapshot.version) {
        return dropped(
          aggregate,
          stream,
          eventStore,
          "ahead",
          "snapshot is past the stream's head; the stream is folded from its first event",
          { version: snapshot.version, head: loaded.version },
        );
      }
      const folded = foldState({ aggregate, events: loaded.events, from });
      if (!due(aggregate, settings.verify)) {
        count(aggregate, "used");
        return { folded, version: loaded.version };
      }
      const whole = await fromStart(aggregate, stream, eventStore, loaded.version);
      if (foldsEqual(folded, whole.folded)) {
        count(aggregate, "verified");
        return { folded, version: loaded.version };
      }
      count(aggregate, "mismatch");
      const message = `Snapshot of ${aggregate.name}:${aggregateId} at version ${snapshot.version} folds to a state at version ${loaded.version} that differs from the stream's; the fold is not a function of the events alone`;
      if (strict) throw new SnapshotError(message);
      logger.error("snapshot folds to a state that differs from the stream; dropped", {
        ...stream,
        version: snapshot.version,
        head: loaded.version,
      });
      await snapshotStore.remove(stream);
      return whole;
    },
  };
};
