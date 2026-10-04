import type { StoragePorts } from "../adapter/adapter.ts";
import { type DeferredStores, deferWrites } from "../adapter/deferred-writes.ts";
import type { CheckpointStore } from "../adapter/ports/checkpoint-store.ts";
import { createStagedEventStore } from "../adapter/staged-event-store.ts";
import type { MemoryDeadLetterStore } from "./dead-letter-store.ts";
import type { EntryWrite, TrackedWrite } from "./entry-journal.ts";
import type { MemoryEventStore } from "./event-store.ts";
import type { MemoryInboxLedger } from "./inbox-ledger.ts";
import type { MemoryScheduler } from "./scheduler.ts";

export interface CreateMemoryStorageTransactionArgs {
  readonly eventStore: MemoryEventStore;
  readonly inboxLedger: MemoryInboxLedger;
  readonly deadLetterStore: MemoryDeadLetterStore;
  readonly scheduler: MemoryScheduler;
}

export interface CreateMemoryStorageTransactionFunction {
  (args: CreateMemoryStorageTransactionArgs): StoragePorts["transact"];
}

type MemoryDeferredStores = Omit<CreateMemoryStorageTransactionArgs, "eventStore">;

interface WriteJournal {
  readonly target: DeferredStores;
  keep(): void;
  /**
   * Undoes every write made through `target`.
   */
  undo(): void;
}

const createWriteJournal = ({
  inboxLedger,
  deadLetterStore,
  scheduler,
}: MemoryDeferredStores): WriteJournal => {
  const writes: EntryWrite[] = [];
  const tracked =
    <Args extends [unknown, ...unknown[]], Result>(
      track: (first: NoInfer<Args[0]>) => TrackedWrite,
      write: (...args: Args) => Promise<Result>,
    ) =>
    async (...args: Args): Promise<Result> => {
      const written = track(args[0]);
      try {
        return await write(...args);
      } finally {
        writes.push(written());
      }
    };
  return {
    target: {
      inboxLedger: {
        ...inboxLedger,
        complete: tracked(inboxLedger.track, (args) => inboxLedger.complete(args)),
        fail: tracked(inboxLedger.track, (args) => inboxLedger.fail(args)),
      },
      deadLetterStore: {
        ...deadLetterStore,
        add: tracked(
          (letter) => deadLetterStore.track(letter.id),
          (letter) => deadLetterStore.add(letter),
        ),
        updateStatus: tracked(deadLetterStore.track, (id, status) =>
          deadLetterStore.updateStatus(id, status),
        ),
        remove: tracked(deadLetterStore.track, (id) => deadLetterStore.remove(id)),
      },
      scheduler: {
        ...scheduler,
        schedule: tracked(
          (args) => scheduler.track(args.dedupeKey),
          (args) => scheduler.schedule(args),
        ),
        cancel: tracked(scheduler.track, (dedupeKey) => scheduler.cancel(dedupeKey)),
        complete: tracked(
          (claim) => scheduler.track(claim.dedupeKey),
          (claim) => scheduler.complete(claim),
        ),
        fail: tracked(
          (args) => scheduler.track(args.claim.dedupeKey),
          (args) => scheduler.fail(args),
        ),
        defer: tracked(
          (args) => scheduler.track(args.claim.dedupeKey),
          (args) => scheduler.defer(args),
        ),
      },
    },
    keep: () => {
      for (const write of writes.splice(0)) write.keep();
    },
    undo: () => {
      for (const write of writes.splice(0)) write.undo();
    },
  };
};

/**
 * `StoragePorts.transact` for the memory stores. Appends are staged and the other writes deferred
 * while the work runs; once it resolves, the deferred writes are applied, then every stream is
 * appended in one synchronous run with every version checked first, so no reader sees one stream
 * appended without the others. A write that fails undoes the writes this transaction applied,
 * and nothing has been appended by then; a stale version appends nothing and undoes them too.
 * Transactions are not serialized, so the undo leaves alone what another committed meanwhile.
 * `tryClaim`, `claimDue` and both `renew` act at once, outside the transaction.
 */
export const createMemoryStorageTransaction: CreateMemoryStorageTransactionFunction =
  ({ eventStore, ...live }) =>
  async (work) => {
    const staged = createStagedEventStore(eventStore);
    const { ports, flush } = deferWrites(live);
    const result = await work({ eventStore: staged, ...ports });
    const journal = createWriteJournal(live);
    try {
      await flush(journal.target);
      await eventStore.appendAll(staged.batches());
    } catch (error) {
      journal.undo();
      throw error;
    }
    journal.keep();
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
