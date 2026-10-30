import type { Snapshot, SnapshotStore } from "../adapter/storage/snapshot-store.ts";
import { streamId } from "../contracts/event.ts";

export interface CreateMemorySnapshotStoreFunction {
  (): SnapshotStore;
}

export const createMemorySnapshotStore: CreateMemorySnapshotStoreFunction = () => {
  const snapshots = new Map<string, Snapshot>();
  return {
    get: async (stream) => snapshots.get(streamId(stream)) ?? null,
    put: async (snapshot) => {
      snapshots.set(streamId(snapshot), snapshot);
    },
    remove: async (stream) => {
      snapshots.delete(streamId(stream));
    },
  };
};
