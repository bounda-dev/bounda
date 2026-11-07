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
    transact: (work) =>
      storage.transact((transaction) => {
        const keys = wrapping.over(transaction.personalKeys);
        return work({
          ...transaction,
          personalKeys: keys,
          eventStore: withPersonalData({ eventStore: transaction.eventStore, aggregates, keys }),
        });
      }),
  };
};
