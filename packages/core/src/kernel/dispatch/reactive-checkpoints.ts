import type { CheckpointStore } from "../../adapter/ports/checkpoint-store.ts";
import type { EventStore } from "../../adapter/ports/event-store.ts";

export interface AlignReactiveCheckpointsArgs {
  readonly eventStore: EventStore;
  readonly checkpointStore: CheckpointStore;
  readonly following: readonly string[];
  readonly idle: readonly string[];
}

export interface AlignReactiveCheckpointsFunction {
  (args: AlignReactiveCheckpointsArgs): Promise<void>;
}

/**
 * Where an app without policies, or without processes, leaves their checkpoint. Removing it would
 * make an instance still running code that has them read the stream again from 0; parked, it
 * reads nothing, and a later deploy that brings them back starts them at the head.
 */
export const PARKED_POSITION: number = Number.MAX_SAFE_INTEGER;

/**
 * Policies and processes react only to what happens after they are deployed, so a new one starts
 * at the head. The head is read before the checkpoints so an event stored in between is still
 * delivered, and `compareAndSet` keeps a checkpoint another instance wrote meanwhile.
 */
export const alignReactiveCheckpoints: AlignReactiveCheckpointsFunction = async ({
  eventStore,
  checkpointStore,
  following,
  idle,
}) => {
  const head = await eventStore.lastPosition();
  const positions = new Map(
    (await checkpointStore.list()).map(({ subscriber, position }) => [subscriber, position]),
  );
  for (const subscriber of idle) {
    const position = positions.get(subscriber);
    if (position !== undefined && position !== PARKED_POSITION) {
      await checkpointStore.set(subscriber, PARKED_POSITION);
    }
  }
  for (const subscriber of following) {
    const position = positions.get(subscriber);
    if (position === undefined) await checkpointStore.compareAndSet(subscriber, 0, head);
    else if (position === PARKED_POSITION) {
      await checkpointStore.compareAndSet(subscriber, PARKED_POSITION, head);
    }
  }
};
