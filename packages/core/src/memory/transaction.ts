import type { StoragePorts, StorageTransaction } from "../adapter/adapter.ts";
import type { CheckpointStore } from "../adapter/ports/checkpoint-store.ts";
import type { DeadLetterStore } from "../adapter/ports/dead-letter-store.ts";
import type { InboxLedger } from "../adapter/ports/inbox-ledger.ts";
import type { Scheduler } from "../adapter/ports/scheduler.ts";
import { createStagedEventStore } from "../adapter/staged-event-store.ts";
import type { MemoryDeadLetterStore } from "./dead-letter-store.ts";
import type { MemoryEventStore } from "./event-store.ts";
import type { MemoryInboxLedger } from "./inbox-ledger.ts";
import type { MemoryScheduler } from "./scheduler.ts";

export interface SnapshotMapFunction {
  <Key, Value>(map: Map<Key, Value>): () => void;
}

/**
 * Copies `map` and returns what puts it back the way it was.
 */
export const snapshotMap: SnapshotMapFunction = (map) => {
  const saved = new Map(map);
  return () => {
    map.clear();
    for (const [key, value] of saved) map.set(key, value);
  };
};

export interface CreateMemoryStorageTransactionArgs {
  readonly eventStore: MemoryEventStore;
  readonly inboxLedger: MemoryInboxLedger;
  readonly deadLetterStore: MemoryDeadLetterStore;
  readonly scheduler: MemoryScheduler;
}

export interface CreateMemoryStorageTransactionFunction {
  (args: CreateMemoryStorageTransactionArgs): StoragePorts["transact"];
}

/**
 * `StoragePorts.transact` for the memory stores. Appends are staged and the other writes deferred
 * while the work runs; once it resolves, the deferred writes are applied, then every stream is
 * appended in one synchronous run with every version checked first, so no reader sees one stream
 * appended without the others. A write that fails puts the ledger, the dead letters and the
 * scheduler back from their snapshots, and nothing has been appended by then; a stale version
 * appends nothing and puts them back too. `tryClaim` and `claimDue` answer at once, outside the
 * transaction.
 */
export const createMemoryStorageTransaction: CreateMemoryStorageTransactionFunction =
  ({ eventStore, inboxLedger, deadLetterStore, scheduler }) =>
  async (work) => {
    const staged = createStagedEventStore(eventStore);
    const deferred: (() => Promise<unknown>)[] = [];
    const later =
      <Args extends unknown[]>(write: (...args: Args) => Promise<unknown>) =>
      async (...args: Args): Promise<void> => {
        deferred.push(() => write(...args));
      };
    const ledger: InboxLedger = {
      tryClaim: inboxLedger.tryClaim,
      get: inboxLedger.get,
      complete: later(inboxLedger.complete),
      fail: later(inboxLedger.fail),
    };
    const letters: DeadLetterStore = {
      get: deadLetterStore.get,
      list: deadLetterStore.list,
      count: deadLetterStore.count,
      add: async (letter) => {
        deferred.push(() => deadLetterStore.add(letter));
        return { ...letter, status: "failed" };
      },
      updateStatus: later(deadLetterStore.updateStatus),
      remove: later(deadLetterStore.remove),
    };
    const schedule: Scheduler = {
      claimDue: scheduler.claimDue,
      nextDueAt: scheduler.nextDueAt,
      list: scheduler.list,
      schedule: later(scheduler.schedule),
      cancel: later(scheduler.cancel),
      complete: later(scheduler.complete),
      fail: later(scheduler.fail),
      defer: later(scheduler.defer),
    };
    const transaction: StorageTransaction = {
      eventStore: staged,
      inboxLedger: ledger,
      deadLetterStore: letters,
      scheduler: schedule,
    };
    const result = await work(transaction);
    const restore = [inboxLedger, deadLetterStore, scheduler].map((store) => store.snapshot());
    try {
      await Promise.all(deferred.map((write) => write()));
      await eventStore.appendAll(staged.batches());
    } catch (error) {
      for (const undo of restore) undo();
      throw error;
    }
    return result;
  };

export interface MemoryLocks {
  /**
   * Resolves to what releases the lock; with `wait` false, to `undefined` at once when someone
   * holds it.
   */
  acquire(name: string, wait: boolean): Promise<(() => void) | undefined>;
}

export interface CreateMemoryLocksFunction {
  (): MemoryLocks;
}

export const createMemoryLocks: CreateMemoryLocksFunction = () => {
  const tails = new Map<string, Promise<void>>();
  return {
    acquire: async (name, wait) => {
      const held = tails.get(name);
      if (held !== undefined && !wait) return undefined;
      let release = (): void => {};
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = (held ?? Promise.resolve()).then(() => mine);
      tails.set(name, tail);
      await held;
      return () => {
        if (tails.get(name) === tail) tails.delete(name);
        release();
      };
    },
  };
};

export interface CheckpointJournal {
  readonly store: CheckpointStore;
  /**
   * Puts back, newest first, every checkpoint `store` changed, as long as nobody changed it again
   * since.
   */
  undo(): Promise<void>;
}

interface CheckpointChange {
  readonly subscriber: string;
  readonly before: number;
  readonly after: number;
}

export interface CreateCheckpointJournalFunction {
  (base: CheckpointStore): CheckpointJournal;
}

/**
 * Writes through to `base` at once, as a row a database transaction updates, and remembers each
 * change so that a rolled back transaction can undo it.
 */
export const createCheckpointJournal: CreateCheckpointJournalFunction = (base) => {
  const changes: CheckpointChange[] = [];
  const changed = async (subscriber: string, before: number): Promise<void> => {
    changes.push({ subscriber, before, after: await base.get(subscriber) });
  };
  return {
    store: {
      get: (subscriber) => base.get(subscriber),
      list: () => base.list(),
      set: async (subscriber, position) => {
        const before = await base.get(subscriber);
        await base.set(subscriber, position);
        await changed(subscriber, before);
      },
      compareAndSet: async (subscriber, expected, position) => {
        const swapped = await base.compareAndSet(subscriber, expected, position);
        if (swapped) await changed(subscriber, expected);
        return swapped;
      },
      remove: async (subscriber) => {
        const before = await base.get(subscriber);
        await base.remove(subscriber);
        await changed(subscriber, before);
      },
    },
    undo: async () => {
      for (const { subscriber, before, after } of changes.splice(0).reverse()) {
        await base.compareAndSet(subscriber, after, before);
      }
    },
  };
};
