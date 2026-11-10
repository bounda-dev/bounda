import type { Storage } from "../adapter/adapter.ts";
import {
  type DeferredStores,
  type DeferredWrites,
  type DeferredWriteTarget,
  deferWrites,
} from "../adapter/deferred-writes.ts";
import { createStagedEventStore, type StagedBatch } from "../adapter/staged-event-store.ts";
import type { CheckpointStore } from "../adapter/storage/checkpoint-store.ts";
import type { DeadLetterStore } from "../adapter/storage/dead-letter-store.ts";
import type { IdempotencyStore } from "../adapter/storage/idempotency-store.ts";
import type { ClaimKey, InboxLedger } from "../adapter/storage/inbox-ledger.ts";
import type { PersonActivity, PersonStore } from "../adapter/storage/person-store.ts";
import {
  keyedPersonId,
  namesPerson,
  type PersonalKeyStore,
} from "../adapter/storage/personal-key-store.ts";
import type { Scheduler } from "../adapter/storage/scheduler.ts";
import type { SnapshotStore } from "../adapter/storage/snapshot-store.ts";
import type { StoreEntries } from "./entries.ts";
import type { MemoryEventStore } from "./event-store.ts";
import { blankPerson } from "./person-store.ts";

export interface CreateMemoryStorageTransactionArgs {
  readonly eventStore: MemoryEventStore;
  readonly inboxLedger: InboxLedger;
  readonly deadLetterStore: DeadLetterStore;
  readonly scheduler: Scheduler;
  readonly idempotencyStore: IdempotencyStore;
  readonly personalKeys: PersonalKeyStore;
  readonly persons: PersonStore;
  readonly snapshotStore: SnapshotStore;
  readonly entries: {
    readonly inboxLedger: StoreEntries<ClaimKey>;
    readonly deadLetterStore: StoreEntries<string>;
    readonly scheduler: StoreEntries<string>;
    readonly idempotencyStore: StoreEntries<string>;
    readonly personalKeys: StoreEntries<string>;
    readonly persons: StoreEntries<string>;
  };
}

export interface CreateMemoryStorageTransactionFunction {
  (args: CreateMemoryStorageTransactionArgs): Storage["transact"];
}

type CreateUndoLogArgs = Omit<
  CreateMemoryStorageTransactionArgs,
  "eventStore" | "personalKeys" | "persons" | "snapshotStore"
>;

interface UndoLog {
  readonly target: DeferredWriteTarget;
  undo(): void;
}

type Undos = (() => void)[];

// What a failed write puts back when someone changed the entry since, from the entry before the
// write, after it, and now; without one, the entry is left as they wrote it.
type Merge = (before: unknown, after: unknown, now: unknown) => unknown;

const trackedBy =
  (undos: Undos, merge?: Merge) =>
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
    undos.push(() => {
      const now = store.read(key);
      if (merge === undefined || now === after) store.putBack(key, before, after);
      else store.putBack(key, merge(before, after, now), now);
    });
    return written;
  };

// The events check at commit what a store checks as they are appended. A key the transaction itself
// removed, or a person it restricted, came after its appends, as a forget staged to run at commit
// does, or was seen by the kernel before them, so it is left out of the check; a key it gave
// afterwards is still checked.
const ownChangesLeftOut = (
  batches: readonly StagedBatch[],
  removed: ReadonlySet<string>,
  restricted: ReadonlySet<string>,
): readonly StagedBatch[] =>
  batches.map((batch) => ({
    ...batch,
    persons: batch.persons.filter((held) => !removed.has(keyedPersonId(held))),
    touches: batch.touches.filter((person) => !restricted.has(person)),
  }));

const isRow = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

// A person's row is written field by field, by writers that may run beside a transaction that
// later fails, such as a restriction beside a forget: each field the write changed goes back
// unless someone changed that field since, and the fields they wrote stay. A row the write
// created goes back to a blank one.
const personFields: Merge = (before, after, now) => {
  if (!isRow(after) || !isRow(now)) return now;
  const was: Readonly<Record<string, unknown>> = isRow(before)
    ? before
    : { ...blankPerson(String(now.person)) };
  const merged: Record<string, unknown> = { ...now };
  for (const [field, value] of Object.entries(after)) {
    if (now[field] === value && was[field] !== value) merged[field] = was[field];
  }
  return merged;
};

const undoAll = (undos: Undos): void => {
  for (const undo of undos.splice(0).reverse()) undo();
};

// The keys are written at once, since `add` answers with the key in force, and put back when the
// transaction fails. Each key it removes or retains goes in `removed`, as `keyedPersonId` names it:
// a read made while it was in force no longer holds.
const trackedPersonalKeys = (
  personalKeys: PersonalKeyStore,
  entries: StoreEntries<string>,
  undos: Undos,
  removed: Set<string>,
): PersonalKeyStore => {
  const tracked = trackedBy(undos);
  const id = (person: string, fingerprint: string): string =>
    keyedPersonId({ person, fingerprint });
  return {
    get: (person, category) => personalKeys.get(person, category),
    find: (person, fingerprint) => personalKeys.find(person, fingerprint),
    list: (person) => personalKeys.list(person),
    add: (person, category, key) =>
      tracked(entries, id(person, key.fingerprint), () => personalKeys.add(person, category, key)),
    remove: async (person, fingerprint) => {
      removed.add(id(person, fingerprint));
      return tracked(entries, id(person, fingerprint), () =>
        personalKeys.remove(person, fingerprint),
      );
    },
    retain: async (person, fingerprint, args) => {
      removed.add(id(person, fingerprint));
      return tracked(entries, id(person, fingerprint), () =>
        personalKeys.retain(person, fingerprint, args),
      );
    },
    // Several entries at once, each put back as `tracked` puts one back.
    touch: async (person, lastActiveAt) => {
      const ids = (await personalKeys.list(person)).map(({ key }) => id(person, key.fingerprint));
      const before = ids.map((at) => entries.read(at));
      await personalKeys.touch(person, lastActiveAt);
      ids.forEach((at, index) => {
        const after = entries.read(at);
        undos.push(() => entries.putBack(at, before[index], after));
      });
    },
    listDue: (args) => personalKeys.listDue(args),
    holdDue: (person, fingerprint, lastActiveAt, hold) =>
      tracked(entries, id(person, fingerprint), () =>
        personalKeys.holdDue(person, fingerprint, lastActiveAt, hold),
      ),
    nextDueHoldEnd: (args) => personalKeys.nextDueHoldEnd(args),
    listRetained: (args) => personalKeys.listRetained(args),
    nextRetainedHoldEnd: (args) => personalKeys.nextRetainedHoldEnd(args),
    listWrappedUnder: (args) => personalKeys.listWrappedUnder(args),
    rewrap: (person, from, to) =>
      tracked(entries, id(person, from.fingerprint), () => personalKeys.rewrap(person, from, to)),
    hold: (person, from, hold) =>
      tracked(entries, id(person, from.fingerprint), () => personalKeys.hold(person, from, hold)),
    nextHoldEnd: (args) => personalKeys.nextHoldEnd(args),
    countWrappedUnder: (args) => personalKeys.countWrappedUnder(args),
    // Only after a restore, never inside a transaction.
    releaseHolds: () => personalKeys.releaseHolds(),
    countDue: (args) => personalKeys.countDue(args),
    countRetained: (args) => personalKeys.countRetained(args),
    releaseDueHolds: () => personalKeys.releaseDueHolds(),
  };
};

// Written at once, as the keys are, since each write answers whether it changed the row, and put
// back when the transaction fails. Whom it restricts goes in `restricted`. A record answers
// nothing, so it waits for the commit in `recorded`, as a database makes a record beside it wait
// for the row: written at once, it would hide an earlier activity recorded meanwhile, which its
// undo could not bring back.
const trackedPersons = (
  persons: PersonStore,
  entries: StoreEntries<string>,
  undos: Undos,
  restricted: Set<string>,
  recorded: PersonActivity[],
): PersonStore => {
  const tracked = trackedBy(undos, personFields);
  return {
    get: (person) => persons.get(person),
    restrict: (person, since) => {
      restricted.add(person);
      return tracked(entries, person, () => persons.restrict(person, since));
    },
    unrestrict: (person) => tracked(entries, person, () => persons.unrestrict(person)),
    record: async (activity) => {
      recorded.push(activity);
    },
    listIdle: (args) => persons.listIdle(args),
    hold: (person, lastActiveAt, hold) =>
      tracked(entries, person, () => persons.hold(person, lastActiveAt, hold)),
    nextHoldEnd: (after) => persons.nextHoldEnd(after),
    countIdle: (args) => persons.countIdle(args),
    // Only after a restore, never inside a transaction.
    releaseHolds: () => persons.releaseHolds(),
  };
};

// Removed at once, as the keys are, so a forget answers what it removed: a worker that settles
// the claim of a command it cancelled finds it lost, and one that dead-lettered it first has its
// letter found. Put back the same way when the transaction fails. What the transaction itself
// wrote is still held back, so it is withdrawn from there, as a store that sees its own writes
// would remove it.
const trackedForgets = (
  { stores, withdrawScheduled, withdrawLetters }: DeferredWrites,
  { scheduler, deadLetterStore, entries }: CreateUndoLogArgs,
  undos: Undos,
): Pick<DeferredStores, "scheduler" | "deadLetterStore"> => {
  const tracked = trackedBy(undos);
  return {
    scheduler: {
      ...stores.scheduler,
      forget: async (person, keep) => {
        const named = (await scheduler.list()).filter((entry) => namesPerson(entry, person, keep));
        for (const { dedupeKey } of named) {
          await tracked(entries.scheduler, dedupeKey, () => scheduler.cancel(dedupeKey));
        }
        const staged = withdrawScheduled(person, keep);
        const keys = new Set(staged.map(({ dedupeKey }) => dedupeKey));
        return [...named.filter(({ dedupeKey }) => !keys.has(dedupeKey)), ...staged];
      },
    },
    deadLetterStore: {
      ...stores.deadLetterStore,
      forget: async (person, keep) => {
        const named = (await deadLetterStore.list()).filter((letter) =>
          namesPerson(letter, person, keep),
        );
        for (const { id } of named) {
          await tracked(entries.deadLetterStore, id, () => deadLetterStore.remove(id));
        }
        // A letter added under an id the store holds already changes nothing, so it stays as stored.
        const ids = new Set(named.map(({ id }) => id));
        return [...named, ...withdrawLetters(person, keep).filter(({ id }) => !ids.has(id))];
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
        updateStatus: (id, status, at) =>
          tracked(entries.deadLetterStore, id, () => deadLetterStore.updateStatus(id, status, at)),
        remove: (id) => tracked(entries.deadLetterStore, id, () => deadLetterStore.remove(id)),
        reseal: (id, letter) =>
          tracked(entries.deadLetterStore, id, () => deadLetterStore.reseal(id, letter)),
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
        reseal: (args) => tracked(entries.scheduler, args.dedupeKey, () => scheduler.reseal(args)),
      },
      idempotencyStore: {
        put: (args) =>
          tracked(entries.idempotencyStore, args.key, () => idempotencyStore.put(args)),
        // Not put back: a rejection forgotten is decided again, which is all it costs.
        forget: (person, keep) => idempotencyStore.forget(person, keep),
      },
    },
    undo: () => undoAll(undos),
  };
};

/**
 * `Storage.transact` for the memory stores. The work's writes are held back, each event staged
 * with the position it will have, reserved from the store, so the work answers the positions
 * its appends will commit with, and the events it reseals written after its appends; transactions then commit one at a time, every stream appended
 * in one synchronous run, so no reader sees one stream appended without the others, nor an
 * event written meanwhile past a position still reserved. A failed transaction appends nothing,
 * gives its positions back and puts back each entry it changed, unless someone changed it since;
 * its personal keys, and the scheduled commands and dead letters it forgets, are written at once
 * and put back the same way, and the snapshots it forgets are gone at once, for good, as a cache
 * can be.
 * `tryClaim`, `claimDue`, both `renew`, both `purge` and writes made on the stores themselves do not
 * wait for a commit, so they can see a write it may still put back.
 */
export const createMemoryStorageTransaction: CreateMemoryStorageTransactionFunction = ({
  eventStore,
  personalKeys,
  persons,
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
    const deferred = deferWrites(live);
    const { stores, flush } = deferred;
    const atOnce: Undos = [];
    const removed = new Set<string>();
    const restricted = new Set<string>();
    const recorded: PersonActivity[] = [];
    try {
      const result = await work({
        eventStore: staged,
        ...stores,
        ...trackedForgets(deferred, live, atOnce),
        personalKeys: trackedPersonalKeys(personalKeys, live.entries.personalKeys, atOnce, removed),
        persons: trackedPersons(persons, live.entries.persons, atOnce, restricted, recorded),
        snapshotStore,
      });
      // A transaction committed from inside this commit, as from a store write, waits forever.
      const release = await commits.acquire("commit", true);
      const log = createUndoLog(live);
      try {
        await flush(log.target);
        await eventStore.appendAll(ownChangesLeftOut(staged.batches(), removed, restricted));
        await eventStore.reseal(staged.reseals());
        for (const activity of recorded) await persons.record(activity);
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
