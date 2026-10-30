import type { Storage } from "../../adapter/adapter.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { withUpcasting } from "../aggregate/upcasting.ts";
import { withPersonalData } from "../personal-data/event-store.ts";

export interface AppStorageArgs {
  readonly storage: Storage;
  readonly aggregates: AggregatesRuntime;
}

export interface AppStorageFunction {
  (args: AppStorageArgs): Storage;
}

/**
 * The storage as the kernel uses it: its event store, and the one of every transaction, seal and
 * open personal fields and upcast what they read, so handlers only ever see current, readable
 * payloads. The adapter's own `eventStore` stays as written, for the global stream.
 */
export const appStorage: AppStorageFunction = ({ storage, aggregates }) => ({
  ...storage,
  eventStore: withUpcasting({
    eventStore: withPersonalData({
      eventStore: storage.eventStore,
      aggregates,
      keys: storage.personalKeys,
    }),
    aggregates,
  }),
  transact: (work) =>
    storage.transact((transaction) =>
      work({
        ...transaction,
        eventStore: withPersonalData({
          eventStore: transaction.eventStore,
          aggregates,
          keys: transaction.personalKeys,
        }),
      }),
    ),
});
