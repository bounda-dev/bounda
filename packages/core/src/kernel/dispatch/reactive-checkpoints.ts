import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";

export interface AlignReactiveCheckpointsArgs {
  readonly eventStore: EventStore;
  readonly checkpointStore: CheckpointStore;
  readonly following: readonly string[];
}

export interface AlignReactiveCheckpointsFunction {
  (args: AlignReactiveCheckpointsArgs): Promise<void>;
}

/**
 * Policies and processes react only to what happens after they are deployed, so a new one starts
 * at the head. The head is read before the checkpoints so an event stored in between is still
 * delivered, and `compareAndSet` from 0 keeps a checkpoint another instance wrote meanwhile. An app
 * without them never touches their checkpoint: during a deploy, an instance of other code may
 * still be following it.
 */
export const alignReactiveCheckpoints: AlignReactiveCheckpointsFunction = async ({
  eventStore,
  checkpointStore,
  following,
}) => {
  const head = await eventStore.lastPosition();
  const known = new Set((await checkpointStore.list()).map(({ subscriber }) => subscriber));
  for (const subscriber of following) {
    if (!known.has(subscriber)) await checkpointStore.compareAndSet(subscriber, 0, head);
  }
};
