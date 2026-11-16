import type { Storage } from "../../adapter/adapter.ts";
import type { StoredAnswer } from "../../adapter/storage/idempotency-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { type AtRestSealer, isSealedAtRest } from "./at-rest.ts";
import { isSealed } from "./crypto.ts";

/**
 * The checkpoint row set once no answer is filed by the caller's key itself any more.
 */
export const EARLIER_ANSWERS_FILED = "personal-data:answers-filed";

// How many records a reading of the idempotency store takes at a time.
const PAGE = 100;

export interface IsEarlierAnswerFunction {
  (answer: StoredAnswer | null): boolean;
}

/**
 * Whether an answer was kept in the clear, by a version that filed it by the caller's key itself:
 * one sealed under persons or the database's key, or erased, is not.
 */
export const isEarlierAnswer: IsEarlierAnswerFunction = (answer) =>
  answer !== null && !isSealed(answer) && !isSealedAtRest(answer);

export interface EarlierAnswers {
  /**
   * Whether every answer filed by the caller's key was filed under its HMAC, as this instance
   * knows.
   */
  settled(): boolean;
  /**
   * Erases every answer filed by the caller's key itself and files it under the key's HMAC, once
   * per instance unless the database says it was done: a retry of what such an answer recorded
   * then finds its key taken, and runs nothing again. Resolves once none is left; a failure is
   * tried again by the next call.
   */
  file(): Promise<void>;
  /**
   * After the database went back to a copy, which may hold such answers again: the next `file`
   * reads the database again.
   */
  reset(): void;
}

export interface CreateEarlierAnswersArgs {
  readonly storage: Pick<Storage, "idempotencyStore" | "checkpointStore">;
  /**
   * What keys are filed by; `null` in an app without keys, which files every key as it is.
   */
  readonly atRest: AtRestSealer | null;
  readonly clock: Clock;
}

export interface CreateEarlierAnswersFunction {
  (args: CreateEarlierAnswersArgs): EarlierAnswers;
}

export const createEarlierAnswers: CreateEarlierAnswersFunction = ({ storage, atRest, clock }) => {
  const { idempotencyStore, checkpointStore } = storage;
  let done = atRest === null;
  let filing: Promise<void> | null = null;
  // Moves on each reset, so a filing that ends after one settles nothing.
  let generation = 0;

  // Filing a record moves it in the order of keys: the store is read again until a reading files
  // nothing.
  const fileAll = async (sealer: AtRestSealer): Promise<void> => {
    if ((await checkpointStore.get(EARLIER_ANSWERS_FILED)) > 0) return;
    for (;;) {
      let moved = 0;
      for (let offset = 0; ; offset += PAGE) {
        const now = clock.now();
        const page = await idempotencyStore.list({ now, limit: PAGE, offset });
        for (const { key, answer } of page) {
          if (!isEarlierAnswer(answer)) continue;
          await idempotencyStore.erase({ key, filed: await sealer.lookup(key), now });
          moved += 1;
        }
        if (page.length < PAGE) break;
      }
      if (moved === 0) break;
    }
    await checkpointStore.set(EARLIER_ANSWERS_FILED, 1);
  };

  return {
    settled: () => done,
    file: () => {
      if (done || atRest === null) return Promise.resolve();
      const started = generation;
      filing ??= fileAll(atRest).then(
        () => {
          if (started === generation) done = true;
        },
        (error: unknown) => {
          if (started === generation) filing = null;
          throw error;
        },
      );
      return filing;
    },
    reset: () => {
      generation += 1;
      done = atRest === null;
      filing = null;
    },
  };
};
