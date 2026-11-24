import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";

export interface AlignReactiveCheckpointsArgs {
  // The stream's head when the app started, read before the checkpoints.
  readonly head: number;
  readonly checkpointStore: CheckpointStore;
  readonly following: readonly string[];
}

export interface AlignReactiveCheckpointsFunction {
  (args: AlignReactiveCheckpointsArgs): Promise<void>;
}

/**
 * Policies and processes react only to what happens after they are deployed, so a new one starts
 * at the head the app started on, read before the checkpoints so an event stored in between is
 * still delivered, and `compareAndSet` from 0 keeps a checkpoint another instance wrote meanwhile.
 * An app without them never touches their checkpoint: during a deploy, an instance of other code
 * may still be following it.
 */
export const alignReactiveCheckpoints: AlignReactiveCheckpointsFunction = async ({
  head,
  checkpointStore,
  following,
}) => {
  const known = new Set((await checkpointStore.list()).map(({ subscriber }) => subscriber));
  for (const subscriber of following) {
    if (!known.has(subscriber)) await checkpointStore.compareAndSet(subscriber, 0, head);
  }
};
