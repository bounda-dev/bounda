import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../adapter/storage/subscriber-failure-store.ts";
import { jsonCopy } from "./json-copy.ts";

export interface MemorySubscriberFailureStore extends SubscriberFailureStore {
  /**
   * Every row as kept, for `inspect`.
   */
  rows(): readonly StoredSubscriberFailure[];
}

export interface CreateMemorySubscriberFailureStoreFunction {
  (): MemorySubscriberFailureStore;
}

export const createMemorySubscriberFailureStore: CreateMemorySubscriberFailureStoreFunction =
  () => {
    const failures = new Map<string, StoredSubscriberFailure>();
    return {
      record: async ({ failedAt, ...failure }) => {
        const kept = failures.get(failure.subscriber);
        const again = kept?.resolvedAt === null && kept.eventId === failure.eventId;
        failures.set(
          failure.subscriber,
          jsonCopy({
            ...failure,
            attempts: again ? kept.attempts + 1 : 1,
            firstFailedAt: again ? kept.firstFailedAt : failedAt,
            lastFailedAt: failedAt,
            resolvedAt: null,
          }),
        );
      },
      resolve: async (subscriber, at) => {
        const kept = failures.get(subscriber);
        if (kept === undefined || kept.resolvedAt !== null) return;
        failures.set(subscriber, { ...kept, resolvedAt: at.toISOString() });
      },
      get: async (subscriber) => {
        const kept = failures.get(subscriber);
        return kept === undefined ? null : jsonCopy(kept);
      },
      list: async () =>
        [...failures.values()]
          .sort((a, b) => (a.subscriber < b.subscriber ? -1 : 1))
          .map((kept) => jsonCopy(kept)),
      rows: () => [...failures.values()],
    };
  };
