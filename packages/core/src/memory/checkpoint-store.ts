import type { CheckpointStore } from "../adapter/storage/checkpoint-store.ts";

export interface CreateMemoryCheckpointStoreFunction {
  (): CheckpointStore;
}

export const createMemoryCheckpointStore: CreateMemoryCheckpointStoreFunction = () => {
  const positions = new Map<string, number>();
  return {
    get: async (subscriber) => positions.get(subscriber) ?? 0,
    set: async (subscriber, position) => {
      positions.set(subscriber, position);
    },
    compareAndSet: async (subscriber, expected, position) => {
      if ((positions.get(subscriber) ?? 0) !== expected) return false;
      positions.set(subscriber, position);
      return true;
    },
    remove: async (subscriber) => {
      positions.delete(subscriber);
    },
    list: async () =>
      [...positions.entries()].map(([subscriber, position]) => ({ subscriber, position })),
  };
};
