import { type KeyedPerson, namesPerson } from "../adapter/storage/personal-key-store.ts";
import type { Snapshot, SnapshotStore } from "../adapter/storage/snapshot-store.ts";
import { streamId } from "../contracts/event.ts";

export interface CreateMemorySnapshotStoreArgs {
  /**
   * Whether a person holds the key a snapshot names; synchronous, so `put` checks and writes in
   * one step.
   */
  readonly holds: (held: KeyedPerson) => boolean;
}

export interface MemorySnapshotStore extends SnapshotStore {
  rows(): readonly Snapshot[];
}

export interface CreateMemorySnapshotStoreFunction {
  (args: CreateMemorySnapshotStoreArgs): MemorySnapshotStore;
}

export const createMemorySnapshotStore: CreateMemorySnapshotStoreFunction = ({ holds }) => {
  const snapshots = new Map<string, Snapshot>();
  return {
    rows: () => [...snapshots.values()],
    get: async (stream) => snapshots.get(streamId(stream)) ?? null,
    put: async (snapshot) => {
      const current = snapshots.get(streamId(snapshot));
      const older =
        current !== undefined &&
        current.fingerprint === snapshot.fingerprint &&
        current.version > snapshot.version;
      if (!older && snapshot.persons.every(holds)) snapshots.set(streamId(snapshot), snapshot);
    },
    remove: async (stream) => {
      snapshots.delete(streamId(stream));
    },
    forget: async (person, keep) => {
      for (const [key, snapshot] of snapshots) {
        if (namesPerson(snapshot, person, keep)) snapshots.delete(key);
      }
    },
  };
};
