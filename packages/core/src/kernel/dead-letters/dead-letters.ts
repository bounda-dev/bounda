import type { Storage } from "../../adapter/adapter.ts";
import type {
  DeadLetter,
  ListDeadLettersArgs,
  StoredDeadLetter,
} from "../../adapter/storage/dead-letter-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { DeadLetterSettledError, NotFoundError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import { type RecordAccess, recorded } from "../personal-data/access.ts";
import { type KeyOfFunction, openCommandPayload, sealedKeys } from "../personal-data/commands.ts";
import { openTextWith } from "../personal-data/errors.ts";
import type { ProcessDeadLetters } from "../process/dead-letter-retry.ts";
import { actedBy } from "../shared/causation.ts";
import { thrownValue } from "../shared/retry.ts";
import { tracedOperation } from "../telemetry.ts";
import type { DeadLetterRetry } from "./retry.ts";

/**
 * What an operator can do with the handler runs that gave up. Retrying or discarding a letter
 * leaves its row in place as a record. `list`, `get`, `retry` and `discard` hand out the error's
 * text and the payload opened, so each call is recorded in the access log once it settles, with
 * its outcome, naming the persons the letters name, and rejects with what the log's hook throws.
 */
export interface DeadLetters {
  /**
   * The letters of the store, process ones with how many events are `parked` behind them, with
   * the error's message and stack opened, and a scheduled command's payload with its personal
   * fields opened: `null` for what was sealed under a person forgotten since.
   */
  list(args?: ListDeadLettersArgs): Promise<readonly DeadLetter[]>;
  count(args?: ListDeadLettersArgs): Promise<number>;
  /**
   * One letter of the store, as `list` gives it.
   */
  get(id: string): Promise<DeadLetter | null>;
  /**
   * Runs the failed handler once more: the policy or process handler for the stored event, the
   * process deadline that failed, or the dropped scheduled command with its recorded payload, and
   * marks the letter `retried`: a policy's, a scheduled command's or that of a process event that
   * follows its instance's timeout in the same transaction as what the run writes, any other
   * process's once its instance has drained what was parked, since a retry cut short there is
   * taken up again by retrying the same letter. A scheduled command its aggregate now rejects
   * counts as retried, as the scheduler would have settled it. Rejects with the handler's error
   * when it fails again, and the letter stays `failed`. Rejects without running anything with
   * `NotFoundError` when the letter, or the event or process instance it names, is missing, and
   * with `DeadLetterNotRetriableError` when the app as it now is cannot retry it, or the person
   * whose personal fields a scheduled command holds was forgotten since. Rejects with
   * `DeadLetterSettledError` a letter that is no longer `failed`, or that another retry or a
   * discard settled while this one ran: a retry marked in its own transaction then writes
   * nothing, any other process's has already handled its events. Whoever retries acts in what
   * the run writes, the client's actor (`as`) taking the place of the one the failed run had.
   */
  retry(id: string): Promise<DeadLetter>;
  /**
   * Marks the letter `discarded`. Rejects a letter that is missing, and with
   * `DeadLetterSettledError` one that is no longer `failed`.
   */
  discard(id: string): Promise<DeadLetter>;
}

export interface CreateDeadLettersArgs {
  readonly storage: Storage;
  readonly retries: DeadLetterRetry;
  readonly processes: Pick<ProcessDeadLetters, "parkedBehind" | "stillParked">;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Who retries and discards, for the client bound to them.
   */
  readonly actor?: string | undefined;
  readonly recordAccess: RecordAccess;
}

export interface CreateDeadLettersFunction {
  (args: CreateDeadLettersArgs): DeadLetters;
}

// The person the error's text is sealed under, and those whose fields a payload holds.
const personsOf = (letter: StoredDeadLetter): string[] => [
  ...(letter.person === null ? [] : [letter.person]),
  ...(letter.persons ?? []).map(({ person }) => person),
];

export const createDeadLetters: CreateDeadLettersFunction = ({
  storage,
  retries,
  processes,
  clock,
  logger,
  actor,
  recordAccess,
}) => {
  const failedLetter = async (id: string): Promise<StoredDeadLetter> => {
    const letter = await storage.deadLetterStore.get(id);
    if (letter === null) throw new NotFoundError(`Dead letter "${id}" not found`);
    if (letter.status !== "failed") {
      throw new DeadLetterSettledError({ id, status: letter.status });
    }
    return letter;
  };

  // A forgotten person's error text and fields read as `null`, as an event's do.
  const opened = async (
    { errorMessage, errorStack, payload, ...letter }: StoredDeadLetter,
    keyOf: KeyOfFunction = sealedKeys(storage.personalKeys),
  ): Promise<DeadLetter> => {
    const open = openTextWith(keyOf);
    return {
      ...letter,
      errorMessage: await open(errorMessage),
      ...(errorStack === undefined ? {} : { errorStack: await open(errorStack) }),
      ...(payload === undefined
        ? {}
        : {
            payload: (await openCommandPayload({ payload, keys: storage.personalKeys, keyOf }))
              .payload,
          }),
    };
  };

  const withParked = async (
    letter: StoredDeadLetter,
    keyOf?: KeyOfFunction,
  ): Promise<DeadLetter> => {
    const result = await opened(letter, keyOf);
    if (letter.kind !== "process") return result;
    return { ...result, parked: await processes.parkedBehind(letter) };
  };

  // Each call is recorded however it settles: a retry that fails again rejects with the handler's
  // error, which may quote the person.
  const recordedLetter = <Result>(
    operation: "deadLetters.get" | "deadLetters.retry" | "deadLetters.discard",
    letter: StoredDeadLetter,
    run: () => Promise<Result>,
  ): Promise<Result> =>
    recorded(
      (outcome) =>
        recordAccess({
          operation,
          detail: { letter: letter.id },
          actor,
          persons: personsOf(letter),
          outcome,
        }),
      run,
    );

  const calls: DeadLetters = {
    list: async (args) => {
      // Each person's key read once for the whole page.
      const keyOf = sealedKeys(storage.personalKeys);
      const letters = await storage.deadLetterStore.list(args);
      return recorded(
        (outcome) =>
          recordAccess({
            operation: "deadLetters.list",
            detail: { letters: letters.length },
            actor,
            persons: letters.flatMap(personsOf),
            outcome,
          }),
        () => Promise.all(letters.map((letter) => withParked(letter, keyOf))),
      );
    },
    count: (args) => storage.deadLetterStore.count(args),
    get: async (id) => {
      const letter = await storage.deadLetterStore.get(id);
      if (letter === null) return null;
      return recordedLetter("deadLetters.get", letter, () => withParked(letter));
    },
    retry: async (id) => {
      const letter = await failedLetter(id);
      return recordedLetter("deadLetters.retry", letter, async () => {
        await retries.retry(letter, actor).catch((error: unknown) => {
          throw thrownValue(error);
        });
        logger.info("dead letter retried", {
          id,
          kind: letter.kind,
          handler: letter.handler,
          at: clock.now().toISOString(),
          ...actedBy(actor),
        });
        const retried: DeadLetter = { ...(await opened(letter)), status: "retried" };
        if (letter.kind !== "process") return retried;
        return { ...retried, parked: await processes.stillParked(letter) };
      });
    },
    discard: async (id) => {
      const letter = await failedLetter(id);
      return recordedLetter("deadLetters.discard", letter, async () => {
        await storage.deadLetterStore.updateStatus(id, "discarded");
        logger.info("dead letter discarded", {
          id,
          kind: letter.kind,
          handler: letter.handler,
          ...actedBy(actor),
        });
        return { ...(await opened(letter)), status: "discarded" };
      });
    },
  };
  const withSpan =
    <Args extends unknown[], Result>(
      name: keyof DeadLetters,
      call: (...args: Args) => Promise<Result>,
    ) =>
    (...args: Args): Promise<Result> =>
      tracedOperation({ operation: `deadLetters.${name}`, actor, run: () => call(...args) });
  return {
    list: withSpan("list", calls.list),
    count: withSpan("count", calls.count),
    get: withSpan("get", calls.get),
    retry: withSpan("retry", calls.retry),
    discard: withSpan("discard", calls.discard),
  };
};
