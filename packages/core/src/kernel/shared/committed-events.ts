import type { Storage } from "../../adapter/adapter.ts";
import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";

export interface WithCommittedEventsArgs {
  readonly storage: Storage;
  /**
   * Called with the events of each append once they committed: at once outside a transaction,
   * after the transaction otherwise, and never for one that rolled back.
   */
  readonly committed: (events: readonly StoredEvent[]) => void;
}

export interface WithCommittedEventsFunction {
  (args: WithCommittedEventsArgs): Storage;
}

const appendingTo = (
  eventStore: EventStore,
  appended: (events: readonly StoredEvent[]) => void,
): EventStore => ({
  append: async (args) => {
    const result = await eventStore.append(args);
    appended(result.events);
    return result;
  },
  load: (args) => eventStore.load(args),
  readOne: (args) => eventStore.readOne(args),
  readAll: (args) => eventStore.readAll(args),
  readByPerson: (args) => eventStore.readByPerson(args),
  lastPosition: () => eventStore.lastPosition(),
  reseal: (events) => eventStore.reseal(events),
});

/**
 * The storage that reports every event this instance commits.
 */
export const withCommittedEvents: WithCommittedEventsFunction = ({ storage, committed }) => ({
  ...storage,
  eventStore: appendingTo(storage.eventStore, committed),
  transact: async (work) => {
    const appended: StoredEvent[] = [];
    const result = await storage.transact((transaction) => {
      // A store may run the work again on a fresh transaction: only the last run commits.
      appended.length = 0;
      return work({
        ...transaction,
        eventStore: appendingTo(transaction.eventStore, (events) => appended.push(...events)),
      });
    });
    if (appended.length > 0) committed(appended);
    return result;
  },
});
