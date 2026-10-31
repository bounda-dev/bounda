import type { Snapshot, SnapshotStore } from "../adapter/storage/snapshot-store.ts";
import { streamId } from "../contracts/event.ts";

export interface CreateMemorySnapshotStoreArgs {
  /**
   * Whether a person has a personal key; synchronous, so `put` checks and writes in one step.
   */
  readonly holds: (person: string) => boolean;
}

export interface CreateMemorySnapshotStoreFunction {
  (args: CreateMemorySnapshotStoreArgs): SnapshotStore;
}

export const createMemorySnapshotStore: CreateMemorySnapshotStoreFunction = ({ holds }) => {
  const snapshots = new Map<string, Snapshot>();
  return {
    get: async (stream) => snapshots.get(streamId(stream)) ?? null,
    put: async (snapshot) => {
      if (snapshot.persons.every(holds)) snapshots.set(streamId(snapshot), snapshot);
    },
    remove: async (stream) => {
      snapshots.delete(streamId(stream));
    },
    forget: async (person) => {
      for (const [key, snapshot] of snapshots) {
        if (snapshot.persons.includes(person)) snapshots.delete(key);
      }
    },
  };
};
