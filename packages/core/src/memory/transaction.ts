import type { Storage } from "../adapter/adapter.ts";
import {
  type DeferredStores,
  type DeferredWriteTarget,
  deferWrites,
} from "../adapter/deferred-writes.ts";
import { createStagedEventStore } from "../adapter/staged-event-store.ts";
import type { CheckpointStore } from "../adapter/storage/checkpoint-store.ts";
import type { DeadLetterStore } from "../adapter/storage/dead-letter-store.ts";
import type { IdempotencyStore } from "../adapter/storage/idempotency-store.ts";
import type { ClaimKey, InboxLedger } from "../adapter/storage/inbox-ledger.ts";
import { namesPerson, type PersonalKeyStore } from "../adapter/storage/personal-key-store.ts";
import type { Scheduler } from "../adapter/storage/scheduler.ts";
import type { SnapshotStore } from "../adapter/storage/snapshot-store.ts";
import type { StoreEntries } from "./entries.ts";
import type { MemoryEventStore } from "./event-store.ts";

export interface CreateMemoryStorageTransactionArgs {
  readonly eventStore: MemoryEventStore;
  readonly inboxLedger: InboxLedger;
  readonly deadLetterStore: DeadLetterStore;
  readonly scheduler: Scheduler;
  readonly idempotencyStore: IdempotencyStore;
  readonly personalKeys: PersonalKeyStore;
  readonly snapshotStore: SnapshotStore;
  readonly entries: {
    readonly inboxLedger: StoreEntries<ClaimKey>;
    readonly deadLetterStore: StoreEntries<string>;
    readonly scheduler: StoreEntries<string>;
    readonly idempotencyStore: StoreEntries<string>;
    readonly personalKeys: StoreEntries<string>;
  };
}

export interface CreateMemoryStorageTransactionFunction {
  (args: CreateMemoryStorageTransactionArgs): Storage["transact"];
}

type CreateUndoLogArgs = Omit<
  CreateMemoryStorageTransactionArgs,
  "eventStore" | "personalKeys" | "snapshotStore"
>;

interface UndoLog {
  readonly target: DeferredWriteTarget;
  undo(): void;
}

type Undos = (() => void)[];

const trackedBy =
  (undos: Undos) =>
  <Key, Result>(
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

const undoAll = (undos: Undos): void => {
  for (const undo of undos.splice(0).reverse()) undo();
};

// The keys are written at once, since `add` answers with the key in force, and put back when the
// transaction fails.
const trackedPersonalKeys = (
  personalKeys: PersonalKeyStore,
  entries: StoreEntries<string>,
  undos: Undos,
): PersonalKeyStore => {
  const tracked = trackedBy(undos);
  return {
    get: (person) => personalKeys.get(person),
    add: (person, key) => tracked(entries, person, () => personalKeys.add(person, key)),
    remove: (person) => tracked(entries, person, () => personalKeys.remove(person)),
  };
};

// Removed at once, as the keys are, so a forget answers what it removed: a worker that settles
// the claim of a command it cancelled finds it lost, and one that dead-lettered it first has its
// letter found. Put back the same way when the transaction fails.
const trackedForgets = (
  deferred: DeferredStores,
  { scheduler, deadLetterStore, entries }: CreateUndoLogArgs,
  undos: Undos,
): Pick<DeferredStores, "scheduler" | "deadLetterStore"> => {
  const tracked = trackedBy(undos);
  return {
    scheduler: {
      ...deferred.scheduler,
      forget: async (person) => {
        const named = (await scheduler.list()).filter((entry) => namesPerson(entry, person));
        for (const { dedupeKey } of named) {
          await tracked(entries.scheduler, dedupeKey, () => scheduler.cancel(dedupeKey));
        }
        return named;
      },
    },
    deadLetterStore: {
      ...deferred.deadLetterStore,
      forget: async (person) => {
        const named = (await deadLetterStore.list()).filter((letter) =>
          namesPerson(letter, person),
        );
        for (const { id } of named) {
          await tracked(entries.deadLetterStore, id, () => deadLetterStore.remove(id));
        }
        return named;
      },
    },
  };
};

const createUndoLog = ({
  inboxLedger,
  deadLetterStore,
  scheduler,
  idempotencyStore,
  entries,
}: CreateUndoLogArgs): UndoLog => {
  const undos: Undos = [];
  const tracked = trackedBy(undos);
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
      idempotencyStore: {
        put: (args) =>
          tracked(entries.idempotencyStore, args.key, () => idempotencyStore.put(args)),
        // Not put back: a rejection forgotten is decided again, which is all it costs.
        forget: (person) => idempotencyStore.forget(person),
      },
    },
    undo: () => undoAll(undos),
  };
};

/**
 * `Storage.transact` for the memory stores. The work's writes are held back, each event staged
 * with the position it will have, reserved from the store, so the work answers the positions
 * its appends will commit with; transactions then commit one at a time, every stream appended
 * in one synchronous run, so no reader sees one stream appended without the others, nor an
 * event written meanwhile past a position still reserved. A failed transaction appends nothing,
 * gives its positions back and puts back each entry it changed, unless someone changed it since;
 * its personal keys, and the scheduled commands and dead letters it forgets, are written at once
 * and put back the same way, and the snapshots it forgets are gone at once, for good, as a cache
 * can be.
 * `tryClaim`, `claimDue`, both `renew`, `purge` and writes made on the stores themselves do not
 * wait for a commit, so they can see a write it may still put back.
 */
export const createMemoryStorageTransaction: CreateMemoryStorageTransactionFunction = ({
  eventStore,
  personalKeys,
  snapshotStore,
  ...live
}) => {
  const commits = createMemoryLocks();
  return async (work) => {
    const reserved: number[] = [];
    const staged = createStagedEventStore(eventStore, {
      nextPosition: () => {
        const position = eventStore.reserve();
        reserved.push(position);
        return position;
      },
    });
    const { stores, flush } = deferWrites(live);
    const atOnce: Undos = [];
    try {
      const result = await work({
        eventStore: staged,
        ...stores,
        ...trackedForgets(stores, live, atOnce),
        personalKeys: trackedPersonalKeys(personalKeys, live.entries.personalKeys, atOnce),
        snapshotStore,
      });
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
      reserved.length = 0;
      atOnce.length = 0;
      return result;
    } finally {
      eventStore.release(reserved);
      undoAll(atOnce);
    }
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
