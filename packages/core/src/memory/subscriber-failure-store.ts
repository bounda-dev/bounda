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

export interface CreateMemorySubscriberFailureStoreArgs {
  /**
   * Whether the person holds a restriction, answered at once, so `remove` checks it in the step
   * that removes.
   */
  readonly restricted: (person: string) => boolean;
}

export interface CreateMemorySubscriberFailureStoreFunction {
  (args: CreateMemorySubscriberFailureStoreArgs): MemorySubscriberFailureStore;
}

export const createMemorySubscriberFailureStore: CreateMemorySubscriberFailureStoreFunction = ({
  restricted,
}) => {
  const failures = new Map<string, StoredSubscriberFailure>();
  return {
    record: async ({ failedAt, readPersons, ...failure }) => {
      const kept = failures.get(failure.subscriber);
      const again = kept?.resolvedAt === null && kept.eventId === failure.eventId;
      failures.set(
        failure.subscriber,
        jsonCopy({
          ...failure,
          ...(readPersons === undefined || readPersons.length === 0 ? {} : { readPersons }),
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
    reseal: async (subscriber, { eventId, errorMessage, errorStack }) => {
      const kept = failures.get(subscriber);
      if (kept === undefined || kept.eventId !== eventId) return;
      const { errorStack: _, ...rest } = kept;
      failures.set(
        subscriber,
        jsonCopy({ ...rest, errorMessage, ...(errorStack === undefined ? {} : { errorStack }) }),
      );
    },
    get: async (subscriber) => {
      const kept = failures.get(subscriber);
      return kept === undefined ? null : jsonCopy(kept);
    },
    list: async () =>
      [...failures.values()]
        .sort((a, b) => (a.subscriber < b.subscriber ? -1 : 1))
        .map((kept) => jsonCopy(kept)),
    remove: async (failure, unlessRestricted) => {
      const kept = failures.get(failure.subscriber);
      if (
        kept === undefined ||
        unlessRestricted.some(restricted) ||
        kept.eventId !== failure.eventId ||
        kept.attempts !== failure.attempts ||
        kept.lastFailedAt !== failure.lastFailedAt ||
        kept.resolvedAt !== failure.resolvedAt
      ) {
        return false;
      }
      return failures.delete(failure.subscriber);
    },
    clear: async () => {
      failures.clear();
    },
    rows: () => [...failures.values()],
  };
};
