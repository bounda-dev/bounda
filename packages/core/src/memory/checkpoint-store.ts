import type { CheckpointStore } from "../adapter/ports/checkpoint-store.ts";

export interface CreateMemoryCheckpointStoreFunction {
  (): CheckpointStore;
}

/**
 * A checkpoint store held in memory.
 */
export const createMemoryCheckpointStore: CreateMemoryCheckpointStoreFunction = () => {
  const positions = new Map<string, number>();
  return {
    get: async (subscriber) => positions.get(subscriber) ?? 0,
    set: async (subscriber, position) => {
      positions.set(subscriber, position);
    },
    list: async () =>
      [...positions.entries()].map(([subscriber, position]) => ({ subscriber, position })),
  };
};
