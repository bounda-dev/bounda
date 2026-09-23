import type { CheckpointStore } from "../../adapter/ports/checkpoint-store.ts";
import type { EventStore } from "../../adapter/ports/event-store.ts";

export interface AlignReactiveCheckpointsArgs {
  readonly eventStore: EventStore;
  readonly checkpointStore: CheckpointStore;
  /**
   * The policy and process subscribers with something to handle: the dispatcher feeds them.
   */
  readonly following: readonly string[];
  /**
   * The ones with nothing to handle: left out of the dispatcher.
   */
  readonly idle: readonly string[];
}

export interface AlignReactiveCheckpointsFunction {
  (args: AlignReactiveCheckpointsArgs): Promise<void>;
}

/**
 * Policies and processes react to what happens after they are deployed, never to the history
 * before them. A subscriber with nothing to handle is kept out of the dispatcher, so it costs no
 * reads, no checkpoint writes and no wake-ups, and its checkpoint is forgotten. A subscriber that
 * follows the stream without a checkpoint, the first time an app has a policy or a process, starts
 * at the last position stored instead of 0. The head is read before the checkpoints so that an
 * event stored in between is delivered, and `compareAndSet` from 0 leaves alone a checkpoint that
 * another instance wrote meanwhile.
 */
export const alignReactiveCheckpoints: AlignReactiveCheckpointsFunction = async ({
  eventStore,
  checkpointStore,
  following,
  idle,
}) => {
  const head = await eventStore.lastPosition();
  const known = new Set((await checkpointStore.list()).map(({ subscriber }) => subscriber));
  for (const subscriber of idle) await checkpointStore.remove(subscriber);
  for (const subscriber of following) {
    if (!known.has(subscriber)) await checkpointStore.compareAndSet(subscriber, 0, head);
  }
};
