import type { StoragePorts } from "../adapter/adapter.ts";
import { type DeferredWriteTarget, deferWrites } from "../adapter/deferred-writes.ts";
import type { CheckpointStore } from "../adapter/ports/checkpoint-store.ts";
import type { DeadLetterStore } from "../adapter/ports/dead-letter-store.ts";
import type { ClaimKey, InboxLedger } from "../adapter/ports/inbox-ledger.ts";
import type { Scheduler } from "../adapter/ports/scheduler.ts";
import { createStagedEventStore } from "../adapter/staged-event-store.ts";
import type { StoreEntries } from "./entries.ts";
import type { MemoryEventStore } from "./event-store.ts";

export interface CreateMemoryStorageTransactionArgs {
  readonly eventStore: MemoryEventStore;
  readonly inboxLedger: InboxLedger;
  readonly deadLetterStore: DeadLetterStore;
  readonly scheduler: Scheduler;
  readonly entries: {
    readonly inboxLedger: StoreEntries<ClaimKey>;
    readonly deadLetterStore: StoreEntries<string>;
    readonly scheduler: StoreEntries<string>;
  };
}

export interface CreateMemoryStorageTransactionFunction {
  (args: CreateMemoryStorageTransactionArgs): StoragePorts["transact"];
}

type CreateUndoLogArgs = Omit<CreateMemoryStorageTransactionArgs, "eventStore">;

interface UndoLog {
  readonly target: DeferredWriteTarget;
  undo(): void;
}

const createUndoLog = ({
  inboxLedger,
  deadLetterStore,
  scheduler,
  entries,
}: CreateUndoLogArgs): UndoLog => {
  const undos: (() => void)[] = [];
  const tracked = <Key, Result>(
    store: StoreEntries<Key>,
    key: NoInfer<Key>,
    write: () => Promise<Result>,
  ): Promise<Result> => {
    const before = store.read(key);
    const written = write();
    // A memory write changes its map before it returns, so this reads its change before anyone
    // else can write the entry.
    const after = store.read(key);
    undos.push(() => store.putBack(key, before, after));
    return written;
  };
  return {
    target: {
      inboxLedger: {
        complete: (args) => tracked(entries.inboxLedger, args, () => inboxLedger.complete(args)),
        fail: (args) => tracked(entries.inboxLedger, args, () => inboxLedger.fail(args)),
      },
      deadLetterStore: {
        add: (letter) =>
          tracked(entries.deadLetterStore, letter.id, () => deadLetterStore.add(letter)),
        updateStatus: (id, status) =>
          tracked(entries.deadLetterStore, id, () => deadLetterStore.updateStatus(id, status)),
        remove: (id) => tracked(entries.deadLetterStore, id, () => deadLetterStore.remove(id)),
      },
      scheduler: {
        schedule: (args) =>
          tracked(entries.scheduler, args.dedupeKey, () => scheduler.schedule(args)),
        cancel: (dedupeKey) =>
          tracked(entries.scheduler, dedupeKey, () => scheduler.cancel(dedupeKey)),
        complete: (claim) =>
          tracked(entries.scheduler, claim.dedupeKey, () => scheduler.complete(claim)),
        fail: (args) =>
          tracked(entries.scheduler, args.claim.dedupeKey, () => scheduler.fail(args)),
        defer: (args) =>
          tracked(entries.scheduler, args.claim.dedupeKey, () => scheduler.defer(args)),
      },
    },
    undo: () => {
      for (const undo of undos.splice(0).reverse()) undo();
    },
  };
};

/**
 * `StoragePorts.transact` for the memory stores. The work's writes are held back; transactions
 * then commit one at a time, every stream appended in one synchronous run, so no reader sees one
 * stream appended without the others. A failed commit appends nothing and puts back each entry it
 * changed, unless someone changed it since. `tryClaim`, `claimDue`, both `renew` and writes made on
 * the stores themselves do not wait for a commit, so they can see a write it may still put back.
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
    // A transaction committed from inside this commit, as from a store write, waits forever.
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
