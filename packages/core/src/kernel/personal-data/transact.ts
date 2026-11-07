import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";

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

export interface CheckPersonIdFunction {
  (personId: unknown, subject: string): asserts personId is string;
}

export const checkPersonId: CheckPersonIdFunction = (personId, subject) => {
  if (typeof personId !== "string" || personId === "") {
    throw new ValidationError(`${subject} needs the id of the person`, [
      { path: ["personId"], message: "Expected a non-empty string" },
    ]);
  }
};
