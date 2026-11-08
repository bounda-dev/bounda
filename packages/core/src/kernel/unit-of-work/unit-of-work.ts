import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import { deferWrites } from "../../adapter/deferred-writes.ts";
import { createStagedEventStore } from "../../adapter/staged-event-store.ts";
import type { KeyedPerson } from "../../adapter/storage/personal-key-store.ts";
import { ConcurrencyError, ProcessingRestrictedError } from "../../contracts/errors.ts";
import { noteReads } from "../personal-data/reads.ts";
import { asError } from "../shared/retry.ts";

/**
 * What a reaction's commands write through while its attempt runs.
 */
export type UnitStores = Pick<
  UnitOfWork,
  "eventStore" | "scheduler" | "idempotencyStore" | "persons" | "atCommit" | "afterCommit" | "read"
>;

/**
 * What one attempt of a reaction changes in the store, held back until `commit`: the events its
 * commands produce, staged per stream and visible to its own loads, and the writes to the other
 * stores, kept in order. `commit` writes all of it in one storage transaction, events first, or
 * nothing: a stream that moved since the unit loaded it rejects with `ConcurrencyError`; an
 * append to a stream the unit never loaded checks its version at once instead, as the store
 * would. A unit with nothing staged commits without touching the store. Reads through the unit's stores see the
 * store as it is, plus the unit's own events; `add` answers the letter as filed, whatever the
 * store holds under that id already.
 */
export interface UnitOfWork extends Omit<StorageTransaction, "personalKeys" | "snapshotStore"> {
  commit(): Promise<void>;
  /**
   * Runs `write` on the commit's transaction, after the unit's events and other writes, in the
   * order given: for a write that needs what the transaction's stores answer, as forgetting a
   * person does. Never for a unit that does not commit.
   */
  atCommit(write: (transaction: StorageTransaction) => Promise<void>): void;
  /**
   * Runs `callback` once the unit has committed, once however often it commits; never for a unit
   * that does not. `callback` must not throw: the commit would look failed when it is done.
   */
  afterCommit(callback: () => void): void;
  /**
   * Records whose personal data the work read, and under which key, so a failure of it is sealed
   * under no other.
   */
  read(persons: readonly KeyedPerson[]): void;
  /**
   * Everything `read` recorded.
   */
  reads(): readonly KeyedPerson[];
}

export interface CreateUnitOfWorkArgs {
  readonly storage: Storage;
}

export interface CreateUnitOfWorkFunction {
  (args: CreateUnitOfWorkArgs): UnitOfWork;
}

export const createUnitOfWork: CreateUnitOfWorkFunction = ({ storage }) => {
  const staged = createStagedEventStore(storage.eventStore);
  const { stores, flush, pending } = deferWrites(storage);
  const atCommit: ((transaction: StorageTransaction) => Promise<void>)[] = [];
  const committed: (() => void)[] = [];
  const read: KeyedPerson[] = [];
  return {
    eventStore: staged,
    ...stores,
    // Read as the store holds it: a restriction is never staged, as nothing a reaction writes
    // changes who is restricted.
    persons: storage.persons,
    commit: async () => {
      const batches = staged.batches();
      const reseals = staged.reseals();
      if (batches.length > 0 || reseals.length > 0 || pending() || atCommit.length > 0) {
        await storage.transact(async (transaction) => {
          for (const batch of batches) await transaction.eventStore.append(batch);
          if (reseals.length > 0) await transaction.eventStore.reseal(reseals);
          await flush(transaction);
          for (const write of atCommit) await write(transaction);
        });
      }
      for (const callback of committed.splice(0)) callback();
    },
    atCommit: (write) => {
      atCommit.push(write);
    },
    afterCommit: (callback) => {
      committed.push(callback);
    },
    read: (persons) => {
      read.push(...persons);
    },
    reads: () => read,
  };
};

/**
 * Thrown by `commitAttempt` for a commit that failed for a reason other than a conflict: the
 * store's failure, not the reaction's, so a caller can tell it from what the work threw.
 */
export class CommitFailed extends Error {
  constructor(cause: unknown) {
    super("commit failed", { cause });
    this.name = "CommitFailed";
  }
}

export interface CommitAttemptArgs {
  readonly storage: Storage;
  /**
   * How many times the work runs again, on a fresh unit, when its commit finds a stream moved.
   */
  readonly concurrencyRetries: number;
  readonly work: (unit: UnitOfWork) => Promise<void>;
  /**
   * Runs before each rerun; what it throws ends the attempt instead.
   */
  readonly beforeRerun?: (() => Promise<void>) | undefined;
}

export interface CommitAttemptFunction {
  (args: CommitAttemptArgs): Promise<void>;
}

/**
 * Runs `work` on a fresh unit of work and commits it. A commit that finds a stream moved runs the
 * work again on another fresh unit, up to `concurrencyRetries` times, then lets the
 * `ConcurrencyError` through. What the work throws carries what it read, for `readUnder`, a value
 * that is no error wrapped in a `ThrownValue` to carry it. A commit refused because a person its
 * events touch was restricted meanwhile throws the refusal, as the work's own dispatch would have;
 * any other failure of the commit is thrown as `CommitFailed`.
 */
export const commitAttempt: CommitAttemptFunction = async ({
  storage,
  concurrencyRetries,
  work,
  beforeRerun,
}) => {
  for (let race = 0; ; race += 1) {
    if (race > 0) await beforeRerun?.();
    const unit = createUnitOfWork({ storage });
    try {
      await work(unit);
    } catch (thrown) {
      const error = asError(thrown);
      noteReads(error, unit.reads());
      throw error;
    }
    try {
      await unit.commit();
      return;
    } catch (error) {
      if (error instanceof ProcessingRestrictedError) throw error;
      if (!(error instanceof ConcurrencyError)) throw new CommitFailed(error);
      if (race >= concurrencyRetries) throw error;
    }
  }
};

/**
 * `commitAttempt` for a caller that does not tell the store's failure from the work's: a commit
 * that fails for a reason other than a conflict throws that failure as it is.
 */
export const commitWork: CommitAttemptFunction = async (args) => {
  try {
    await commitAttempt(args);
  } catch (error) {
    throw error instanceof CommitFailed ? error.cause : error;
  }
};
