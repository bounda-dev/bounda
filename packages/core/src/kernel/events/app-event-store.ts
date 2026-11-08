import type { Storage } from "../../adapter/adapter.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { withUpcasting } from "../aggregate/upcasting.ts";
import { withPersonalData } from "../personal-data/event-store.ts";
import type { PersonalKeyWrapping } from "../personal-data/wrapped-keys.ts";

export interface AppStorageArgs {
  readonly storage: Storage;
  readonly aggregates: AggregatesRuntime;
  readonly wrapping: PersonalKeyWrapping;
}

export interface AppStorageFunction {
  (args: AppStorageArgs): Storage;
}

/**
 * The storage as the kernel uses it: its personal keys, and those of every transaction, come out
 * unwrapped and go in wrapped; its event store, and the one of every transaction, seal and open
 * personal fields and upcast what they read, so handlers only ever see current, readable
 * payloads. The adapter's own `eventStore` stays as written, for the global stream.
 */
export const appStorage: AppStorageFunction = ({ storage, aggregates, wrapping }) => {
  const personalKeys = wrapping.over(storage.personalKeys);
  return {
    ...storage,
    personalKeys,
    eventStore: withUpcasting({
      eventStore: withPersonalData({
        eventStore: storage.eventStore,
        aggregates,
        keys: personalKeys,
      }),
      aggregates,
    }),
    // A key removed is dropped again once the removal commits: a read made before the commit, as
    // a projection's, may have unwrapped it again meanwhile.
    transact: async (work) => {
      const removed: string[] = [];
      const result = await storage.transact((transaction) => {
        removed.length = 0;
        const over = wrapping.over(transaction.personalKeys);
        const keys = {
          ...over,
          remove: (person: string) => {
            removed.push(person);
            return over.remove(person);
          },
        };
        return work({
          ...transaction,
          personalKeys: keys,
          eventStore: withPersonalData({ eventStore: transaction.eventStore, aggregates, keys }),
        });
      });
      for (const person of removed) wrapping.drop(person);
      return result;
    },
  };
};
