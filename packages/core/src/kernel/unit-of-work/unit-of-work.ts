import type { StoragePorts, StorageTransaction } from "../../adapter/adapter.ts";
import type { DeadLetterStore } from "../../adapter/ports/dead-letter-store.ts";
import type { InboxLedger } from "../../adapter/ports/inbox-ledger.ts";
import { createStagedEventStore } from "../../adapter/staged-event-store.ts";

/**
 * The stores a reaction's commands write through while its attempt runs.
 */
export type UnitStores = Pick<StorageTransaction, "eventStore" | "scheduler">;

/**
 * What one attempt of a reaction changes in the store, held back until `commit`: the events its
 * commands produce, staged per stream and visible to its own loads, and the writes to the other
 * stores, kept in order. `commit` writes all of it in one storage transaction, events first, or
 * nothing: a stream that moved since the unit loaded it rejects with `ConcurrencyError`. Reads
 * through the unit's ports see the store as it is, plus the unit's own events.
 */
export interface UnitOfWork extends UnitStores {
  readonly deadLetterStore: DeadLetterStore;
  readonly inboxLedger: InboxLedger;
  commit(): Promise<void>;
}

export interface CreateUnitOfWorkArgs {
  readonly storage: StoragePorts;
}

export interface CreateUnitOfWorkFunction {
  (args: CreateUnitOfWorkArgs): UnitOfWork;
}

type DeferredWrite = (transaction: StorageTransaction) => Promise<unknown>;

export const createUnitOfWork: CreateUnitOfWorkFunction = ({ storage }) => {
  const staged = createStagedEventStore(storage.eventStore);
  const deferred: DeferredWrite[] = [];
  const later =
    <Args extends unknown[]>(
      write: (transaction: StorageTransaction, ...args: Args) => Promise<unknown>,
    ) =>
    async (...args: Args): Promise<void> => {
      deferred.push((transaction) => write(transaction, ...args));
    };
  const { inboxLedger, deadLetterStore, scheduler } = storage;
  return {
    eventStore: staged,
    inboxLedger: {
      tryClaim: inboxLedger.tryClaim,
      get: inboxLedger.get,
      complete: later((tx, key) => tx.inboxLedger.complete(key)),
      fail: later((tx, args) => tx.inboxLedger.fail(args)),
    },
    deadLetterStore: {
      get: deadLetterStore.get,
      list: deadLetterStore.list,
      count: deadLetterStore.count,
      add: async (letter) => {
        deferred.push((tx) => tx.deadLetterStore.add(letter));
        return { ...letter, status: "failed" };
      },
      updateStatus: later((tx, id, status) => tx.deadLetterStore.updateStatus(id, status)),
      remove: later((tx, id) => tx.deadLetterStore.remove(id)),
    },
    scheduler: {
      claimDue: scheduler.claimDue,
      nextDueAt: scheduler.nextDueAt,
      list: scheduler.list,
      schedule: later((tx, args) => tx.scheduler.schedule(args)),
      cancel: later((tx, key) => tx.scheduler.cancel(key)),
      complete: later((tx, claim) => tx.scheduler.complete(claim)),
      fail: later((tx, args) => tx.scheduler.fail(args)),
      defer: later((tx, args) => tx.scheduler.defer(args)),
    },
    commit: () =>
      storage.transact(async (transaction) => {
        for (const batch of staged.batches()) await transaction.eventStore.append(batch);
        for (const write of deferred) await write(transaction);
      }),
  };
};
