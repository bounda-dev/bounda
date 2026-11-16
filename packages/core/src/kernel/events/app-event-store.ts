import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { withUpcasting } from "../aggregate/upcasting.ts";
import { type AtRestSealer, sealedAnswers, sealedSnapshots } from "../personal-data/at-rest.ts";
import { withPersonalData } from "../personal-data/event-store.ts";
import type { PersonalKeys, PersonalKeyWrapping } from "../personal-data/wrapped-keys.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";

export interface AppStorageArgs {
  readonly storage: Storage;
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly wrapping: PersonalKeyWrapping;
  /**
   * Whether the app's ports tell recipients, whose disclosures need each read's fence.
   */
  readonly fenced?: boolean;
  /**
   * What snapshots and remembered answers are sealed under at rest; `null`, or absent, in an app
   * without keys, whose snapshots hold nothing personal.
   */
  readonly atRest?: AtRestSealer | null;
}

export interface AppStorageTransaction extends Omit<StorageTransaction, "personalKeys"> {
  readonly personalKeys: PersonalKeys;
}

export interface AppStorage extends Omit<Storage, "personalKeys" | "transact"> {
  readonly personalKeys: PersonalKeys;
  transact<T>(work: (transaction: AppStorageTransaction) => Promise<T>): Promise<T>;
}

export interface AppStorageFunction {
  (args: AppStorageArgs): AppStorage;
}

/**
 * The storage as the kernel uses it: its personal keys, and those of every transaction, also come
 * out ready to seal and open with; its event store, and the one of every transaction, seal and open
 * personal fields and upcast what they read, so handlers only ever see current, readable
 * payloads; its snapshots and remembered answers, and those of every transaction, are sealed at
 * rest. The adapter's own `eventStore` stays as written, for the global stream.
 */
export const appStorage: AppStorageFunction = ({
  storage,
  aggregates,
  processes,
  wrapping,
  fenced = false,
  atRest = null,
}) => {
  const personalKeys = wrapping.over(storage.personalKeys);
  const sealed = <Stores extends Pick<Storage, "snapshotStore" | "idempotencyStore">>(
    stores: Stores,
  ): Pick<Storage, "snapshotStore" | "idempotencyStore"> =>
    atRest === null
      ? { snapshotStore: stores.snapshotStore, idempotencyStore: stores.idempotencyStore }
      : {
          snapshotStore: sealedSnapshots(stores.snapshotStore, atRest),
          idempotencyStore: sealedAnswers(stores.idempotencyStore, atRest),
        };
  return {
    ...storage,
    ...sealed(storage),
    personalKeys,
    eventStore: withUpcasting({
      eventStore: withPersonalData({
        eventStore: storage.eventStore,
        aggregates,
        processes,
        keys: personalKeys,
        fenced,
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
          remove: (person: string, fingerprint: string) => {
            removed.push(person);
            return over.remove(person, fingerprint);
          },
        };
        return work({
          ...transaction,
          ...sealed(transaction),
          personalKeys: keys,
          eventStore: withPersonalData({
            eventStore: transaction.eventStore,
            aggregates,
            processes,
            keys,
          }),
        });
      });
      for (const person of removed) wrapping.drop(person);
      return result;
    },
  };
};
