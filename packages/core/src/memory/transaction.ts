import type { StoragePorts } from "../adapter/adapter.ts";
import { deferWrites } from "../adapter/deferred-writes.ts";
import type { CheckpointStore } from "../adapter/ports/checkpoint-store.ts";
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
 * appends nothing and puts them back too. `tryClaim`, `claimDue` and `renew` act at once, outside
 * the transaction.
 */
export const createMemoryStorageTransaction: CreateMemoryStorageTransactionFunction =
  ({ eventStore, inboxLedger, deadLetterStore, scheduler }) =>
  async (work) => {
    const staged = createStagedEventStore(eventStore);
    const live = { inboxLedger, deadLetterStore, scheduler };
    const { ports, flush } = deferWrites(live);
    const result = await work({ eventStore: staged, ...ports });
    const restore = [inboxLedger, deadLetterStore, scheduler].map((store) => store.snapshot());
    try {
      await flush(live);
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
