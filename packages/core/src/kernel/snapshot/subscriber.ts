import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { SnapshotStore } from "../../adapter/storage/snapshot-store.ts";
import { SnapshotError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregateLoader } from "../aggregate/load-aggregate.ts";
import type { AggregateRuntime, AggregateSnapshotRuntime } from "../aggregate/runtime.ts";
import { serializeFold } from "../aggregate/snapshot-codec.ts";
import type { Subscriber } from "../dispatch/delivery.ts";
import { errorDetails } from "../shared/retry.ts";

export interface SnapshottedAggregate extends AggregateRuntime {
  readonly snapshot: AggregateSnapshotRuntime;
}

export interface TakesSnapshotsFunction {
  (aggregate: AggregateRuntime): aggregate is SnapshottedAggregate;
}

export const takesSnapshots: TakesSnapshotsFunction = (
  aggregate,
): aggregate is SnapshottedAggregate => aggregate.snapshot !== null;

export interface SnapshotSubscriberNameFunction {
  (aggregate: string): string;
}

export const snapshotSubscriberName: SnapshotSubscriberNameFunction = (aggregate) =>
  `snapshot:${aggregate}`;

export interface CreateSnapshotSubscriberArgs {
  readonly aggregate: SnapshottedAggregate;
  readonly eventStore: EventStore;
  readonly snapshotStore: SnapshotStore;
  readonly loader: AggregateLoader;
  readonly logger: Logger;
  /**
   * For an app from `createTestApp`: a state that cannot be serialized throws `SnapshotError`
   * instead of being logged, and every `SnapshotError` the batch raises is reported before it
   * fails the batch, since the dispatcher only logs a failed batch.
   */
  readonly strict?: {
    onError(error: SnapshotError): void;
  };
}

export interface CreateSnapshotSubscriberFunction {
  (args: CreateSnapshotSubscriberArgs): Subscriber;
}

/**
 * Follows the global stream for one aggregate and writes a snapshot of every stream that gathered
 * `every` events since its last valid one, at the head the load finds: the write is outside any
 * command and idempotent, so two instances taking the same batch do no harm. A state that cannot
 * be serialized is logged and left for the next batch of that stream.
 */
export const createSnapshotSubscriber: CreateSnapshotSubscriberFunction = ({
  aggregate,
  eventStore,
  snapshotStore,
  loader,
  logger,
  strict,
}) => {
  const { every, fingerprint } = aggregate.snapshot;

  const snapshot = async (aggregateId: string): Promise<void> => {
    const stream = { aggregateType: aggregate.name, aggregateId };
    const { folded, version } = await loader.load({ aggregate, aggregateId, eventStore });
    let state: string;
    try {
      state = serializeFold(folded);
    } catch (error) {
      const details = errorDetails(error);
      if (strict !== undefined) {
        throw new SnapshotError(
          `State of ${aggregate.name}:${aggregateId} cannot be snapshotted: ${details.message}`,
          { cause: error },
        );
      }
      logger.error("aggregate state cannot be snapshotted", { ...stream, version, ...details });
      return;
    }
    await snapshotStore.put({ ...stream, version, fingerprint, state });
    logger.debug("snapshot written", { ...stream, version });
  };

  const process = async (heads: ReadonlyMap<string, number>): Promise<void> => {
    for (const [aggregateId, head] of heads) {
      if (head < every) continue;
      const current = await snapshotStore.get({ aggregateType: aggregate.name, aggregateId });
      const since = current !== null && current.fingerprint === fingerprint ? current.version : 0;
      if (head - since >= every) await snapshot(aggregateId);
    }
  };

  return {
    name: snapshotSubscriberName(aggregate.name),
    kind: "snapshot",
    process: async (events) => {
      // Events of one stream come in version order, so the last one seen is its head.
      const heads = new Map<string, number>();
      for (const event of events) {
        if (event.aggregateType === aggregate.name) heads.set(event.aggregateId, event.version);
      }
      try {
        await process(heads);
      } catch (error) {
        if (error instanceof SnapshotError) strict?.onError(error);
        throw error;
      }
      return events.length;
    },
  };
};
