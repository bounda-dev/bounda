import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import { ConcurrencyError, TenantFrozenError, ValidationError } from "../../contracts/errors.ts";

export interface TransactRetryingArgs<Result> {
  readonly storage: Pick<Storage, "transact">;
  readonly concurrencyRetries: number;
  readonly work: (transaction: StorageTransaction) => Promise<Result>;
}

export interface TransactRetryingFunction {
  <Result>(args: TransactRetryingArgs<Result>): Promise<Result>;
}

/**
 * Runs `work` in a transaction of its own, again on a fresh one when it finds a stream moved, up
 * to `concurrencyRetries` times.
 */
export const transactRetrying: TransactRetryingFunction = async ({
  storage,
  concurrencyRetries,
  work,
}) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await storage.transact(work);
    } catch (error) {
      if (!(error instanceof ConcurrencyError) || attempt >= concurrencyRetries) throw error;
    }
  }
};

export interface ThroughFreezeArgs<Result> {
  // Commits what an intention recorded in the forget ledger.
  readonly work: () => Promise<Result>;
  // What the intention's event committed already makes of it, `null` while none is.
  readonly committed: () => Promise<Result | null>;
}

export interface ThroughFreezeFunction {
  <Result>(args: ThroughFreezeArgs<Result>): Promise<Result>;
}

// A freeze raised after the intention commits it before it takes effect, as every intention the
// ledger holds: the request landed then, though its own commit is refused.
export const throughFreeze: ThroughFreezeFunction = async ({ work, committed }) => {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof TenantFrozenError)) throw error;
    const landed = await committed();
    if (landed === null) throw error;
    return landed;
  }
};

export interface CheckPersonIdFunction {
  (personId: unknown, subject: string): asserts personId is string;
}

export interface IsPersonIdFunction {
  (personId: unknown): personId is string;
}

export const isPersonId: IsPersonIdFunction = (personId): personId is string =>
  typeof personId === "string" && personId !== "";

export const checkPersonId: CheckPersonIdFunction = (personId, subject) => {
  if (!isPersonId(personId)) {
    throw new ValidationError(`${subject} needs the id of the person`, [
      { path: ["personId"], message: "Expected a non-empty string" },
    ]);
  }
};
