import type { StoragePorts } from "../adapter/adapter.ts";
import { type DeferredWriteTarget, deferWrites } from "../adapter/deferred-writes.ts";
import type { CheckpointStore } from "../adapter/ports/checkpoint-store.ts";
import { createStagedEventStore } from "../adapter/staged-event-store.ts";
import type { MemoryDeadLetterStore } from "./dead-letter-store.ts";
import { entriesOf } from "./entries.ts";
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

interface UndoLog {
  readonly target: DeferredWriteTarget;
  undo(): void;
}

const createUndoLog = ({
  inboxLedger,
  deadLetterStore,
  scheduler,
}: MemoryDeferredStores): UndoLog => {
  const undos: (() => void)[] = [];
  const tracked = async <Key, Result>(
    store: object,
    key: Key,
    write: () => Promise<Result>,
  ): Promise<Result> => {
    const entries = entriesOf<Key>(store);
    const before = entries.read(key);
    const written = write();
    // A memory write changes its map before it returns, so the change is read before anyone else
    // can write the entry; only a write that awaits first (a test's stand-in) is read once it
    // settles.
    if (entries.read(key) === before) await written.catch(() => undefined);
    const after = entries.read(key);
    undos.push(() => entries.putBack(key, before, after));
    return written;
  };
  return {
    target: {
      inboxLedger: {
        complete: (args) => tracked(inboxLedger, args, () => inboxLedger.complete(args)),
        fail: (args) => tracked(inboxLedger, args, () => inboxLedger.fail(args)),
      },
      deadLetterStore: {
        add: (letter) => tracked(deadLetterStore, letter.id, () => deadLetterStore.add(letter)),
        updateStatus: (id, status) =>
          tracked(deadLetterStore, id, () => deadLetterStore.updateStatus(id, status)),
        remove: (id) => tracked(deadLetterStore, id, () => deadLetterStore.remove(id)),
      },
      scheduler: {
        schedule: (args) => tracked(scheduler, args.dedupeKey, () => scheduler.schedule(args)),
        cancel: (dedupeKey) => tracked(scheduler, dedupeKey, () => scheduler.cancel(dedupeKey)),
        complete: (claim) => tracked(scheduler, claim.dedupeKey, () => scheduler.complete(claim)),
        fail: (args) => tracked(scheduler, args.claim.dedupeKey, () => scheduler.fail(args)),
        defer: (args) => tracked(scheduler, args.claim.dedupeKey, () => scheduler.defer(args)),
      },
    },
    undo: () => {
      for (const undo of undos.splice(0).reverse()) undo();
    },
  };
};

/**
 * `StoragePorts.transact` for the memory stores. Appends are staged and the other writes deferred
 * while the work runs; once it resolves, the transaction commits, one at a time: the deferred
 * writes are applied, then every stream is appended in one synchronous run with every version
 * checked first, so no reader sees one stream appended without the others. A write that fails
 * puts back, newest first, every entry this transaction changed, unless someone changed it since,
 * and nothing has been appended by then; a stale version appends nothing and puts them back too.
 * `tryClaim`, `claimDue` and both `renew` act at once, outside the transaction and its turn, so
 * they can see a write that a commit still under way may put back.
 */
export const createMemoryStorageTransaction: CreateMemoryStorageTransactionFunction = ({
  eventStore,
  ...live
}) => {
  const commits = createMemoryLocks();
  return async (work) => {
    const staged = createStagedEventStore(eventStore);
    const { ports, flush } = deferWrites(live);
    const result = await work({ eventStore: staged, ...ports });
    const release = await commits.acquire("commit", true);
    const log = createUndoLog(live);
    try {
      await flush(log.target);
      await eventStore.appendAll(staged.batches());
    } catch (error) {
      log.undo();
      throw error;
    } finally {
      release?.();
    }
    return result;
  };
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
