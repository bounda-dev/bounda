import type { StoragePorts, StorageTransaction } from "../../adapter/adapter.ts";
import { deferWrites } from "../../adapter/deferred-writes.ts";
import { createStagedEventStore } from "../../adapter/staged-event-store.ts";
import { ConcurrencyError } from "../../contracts/errors.ts";

/**
 * The stores a reaction's commands write through while its attempt runs.
 */
export type UnitStores = Pick<StorageTransaction, "eventStore" | "scheduler">;

/**
 * What one attempt of a reaction changes in the store, held back until `commit`: the events its
 * commands produce, staged per stream and visible to its own loads, and the writes to the other
 * stores, kept in order. `commit` writes all of it in one storage transaction, events first, or
 * nothing: a stream that moved since the unit loaded it rejects with `ConcurrencyError`; an
 * append to a stream the unit never loaded checks its version at once instead, as the store
 * would. A unit with nothing staged commits without touching the store. Reads through the unit's ports see the
 * store as it is, plus the unit's own events; `add` answers the letter as filed, whatever the
 * store holds under that id already.
 */
export interface UnitOfWork extends StorageTransaction {
  commit(): Promise<void>;
}

export interface CreateUnitOfWorkArgs {
  readonly storage: StoragePorts;
}

export interface CreateUnitOfWorkFunction {
  (args: CreateUnitOfWorkArgs): UnitOfWork;
}

export const createUnitOfWork: CreateUnitOfWorkFunction = ({ storage }) => {
  const staged = createStagedEventStore(storage.eventStore);
  const { ports, flush, pending } = deferWrites(storage);
  return {
    eventStore: staged,
    ...ports,
    commit: async () => {
      const batches = staged.batches();
      if (batches.length === 0 && !pending()) return;
      await storage.transact(async (transaction) => {
        for (const batch of batches) await transaction.eventStore.append(batch);
        await flush(transaction);
      });
    },
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
  readonly storage: StoragePorts;
  /**
   * How many times the work runs again, on a fresh unit, when its commit finds a stream moved.
   */
  readonly concurrencyRetries: number;
  readonly work: (unit: UnitOfWork) => Promise<void>;
}

export interface CommitAttemptFunction {
  (args: CommitAttemptArgs): Promise<void>;
}

/**
 * Runs `work` on a fresh unit of work and commits it. A commit that finds a stream moved runs the
 * work again on another fresh unit, up to `concurrencyRetries` times, then lets the
 * `ConcurrencyError` through; any other failure of the commit is thrown as `CommitFailed`.
 */
export const commitAttempt: CommitAttemptFunction = async ({
  storage,
  concurrencyRetries,
  work,
}) => {
  for (let race = 0; ; race += 1) {
    const unit = createUnitOfWork({ storage });
    await work(unit);
    try {
      await unit.commit();
      return;
    } catch (error) {
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
