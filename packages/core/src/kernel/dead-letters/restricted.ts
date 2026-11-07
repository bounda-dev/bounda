import type { Storage } from "../../adapter/adapter.ts";
import type { StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import {
  DeadLetterNotRetriableError,
  DeadLetterSettledError,
  NotFoundError,
  PROCESSING_RESTRICTED,
  ProcessingRestrictedError,
} from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import { sealError } from "../personal-data/errors.ts";
import { restrictedPersonOf } from "../personal-data/refusal.ts";
import { classifyFailure, errorIdentity } from "../shared/retry.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { DeadLetterRetry } from "./retry.ts";

export interface RetryAllArgs {
  readonly personId: string;
  /**
   * Where a letter that fails again for good is written, to commit with the entry's claim.
   */
  readonly unit: UnitOfWork;
  /**
   * Runs before each letter, so the entry's claim covers the next one; what it throws ends the
   * run.
   */
  readonly beforeEach: () => Promise<void>;
  /**
   * Who lifted the restriction, who acts in what each retry writes.
   */
  readonly actor?: string | undefined;
}

export interface RestrictedRetries {
  /**
   * Retries, in the order of `list`, every `failed` letter the person's restriction caused, each
   * as `DeadLetterRetry.retry` does, in its own transaction. One that fails again for good is
   * written again as that failure's letter, under the same id, through `unit`; one that fails in
   * a way worth retrying stays as it is, and the run rejects with that failure once the rest have
   * run, so the entry is retried. One refused because the person is restricted again stops the
   * run, the rest left for the next lift. A letter the app cannot retry is logged and left as it
   * is.
   */
  retryAll(args: RetryAllArgs): Promise<void>;
}

export interface CreateRestrictedRetriesArgs {
  readonly storage: Storage;
  readonly retries: DeadLetterRetry;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateRestrictedRetriesFunction {
  (args: CreateRestrictedRetriesArgs): RestrictedRetries;
}

export const createRestrictedRetries: CreateRestrictedRetriesFunction = ({
  storage,
  retries,
  clock,
  logger,
}) => {
  // The letter as it was, with the new failure in place of the refusal: the same row, so a
  // process instance failed on it stays blocked on it.
  const replace = async (
    unit: UnitOfWork,
    {
      status: _status,
      errorCode: _code,
      errorMessage: _message,
      errorStack: _stack,
      ...letter
    }: StoredDeadLetter,
    error: unknown,
  ): Promise<void> => {
    const person = restrictedPersonOf(error) ?? letter.person;
    await unit.deadLetterStore.remove(letter.id);
    await unit.deadLetterStore.add({
      ...letter,
      person,
      errorType: "terminal",
      ...(await sealError({ error, person, keys: storage.personalKeys })),
      attempts: letter.attempts + 1,
      lastFailedAt: clock.now().toISOString(),
    });
  };

  return {
    retryAll: async ({ personId, unit, beforeEach, actor }) => {
      const letters = await storage.deadLetterStore.listFailed({
        person: personId,
        errorCode: PROCESSING_RESTRICTED,
      });
      let retriable: { readonly error: unknown } | undefined;
      for (const letter of letters) {
        const fields = { id: letter.id, kind: letter.kind, handler: letter.handler, personId };
        await beforeEach();
        try {
          await retries.retry(letter, actor);
          logger.info("dead letter retried once the restriction was lifted", fields);
        } catch (error) {
          if (error instanceof DeadLetterSettledError) continue;
          if (error instanceof ProcessingRestrictedError && error.personId === personId) {
            logger.info("dead letters wait: the person is restricted again", fields);
            return;
          }
          if (error instanceof DeadLetterNotRetriableError || error instanceof NotFoundError) {
            logger.warn("dead letter cannot be retried once the restriction was lifted", {
              ...fields,
              ...errorIdentity(error),
            });
            continue;
          }
          if (classifyFailure(error) === "retriable") {
            logger.warn("dead letter retry failed once the restriction was lifted; will retry", {
              ...fields,
              ...errorIdentity(error),
            });
            retriable ??= { error };
            continue;
          }
          await replace(unit, letter, error);
          logger.warn("dead letter failed again once the restriction was lifted", {
            ...fields,
            ...errorIdentity(error),
          });
        }
      }
      if (retriable !== undefined) throw retriable.error;
    },
  };
};
