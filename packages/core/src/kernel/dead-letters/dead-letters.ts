import type {
  DeadLetter,
  ListDeadLettersArgs,
  StoredDeadLetter,
} from "../../adapter/storage/dead-letter-store.ts";
import type { RestrictionView } from "../../adapter/storage/restricted-persons.ts";
import type { ErrorText } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { DeadLetterSettledError, NotFoundError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { ReadOutcome } from "../../modules/audit.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import { checked, type RecordAccess, recorded } from "../personal-data/access.ts";
import { type KeyOfFunction, openCommandPayload, sealedKeys } from "../personal-data/commands.ts";
import { openTextWith, textPersons } from "../personal-data/errors.ts";
import {
  checkIncludeRestricted,
  type IncludeRestrictedOptions,
  isRestrictionBasis,
  restrictedAmong,
  restrictionViewOf,
  sealedLeft,
} from "../personal-data/restricted-reads.ts";
import type { ProcessDeadLetters } from "../process/dead-letter-retry.ts";
import { actedBy } from "../shared/causation.ts";
import { thrownValue } from "../shared/retry.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { type TracerFunction, tracedOperation } from "../telemetry.ts";
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
   * fields opened: `null` for what was sealed under a person forgotten since. A letter that names
   * a person whose processing is restricted, or holds fields a forgetting kept under a legal
   * obligation, keeps them sealed, reading as `null`, and says `restricted`, unless
   * `includeRestricted` names the basis it is read on.
   */
  list(
    args?: ListDeadLettersArgs,
    options?: IncludeRestrictedOptions,
  ): Promise<readonly DeadLetter[]>;
  count(args?: ListDeadLettersArgs): Promise<number>;
  /**
   * One letter of the store, as `list` gives it.
   */
  get(id: string, options?: IncludeRestrictedOptions): Promise<DeadLetter | null>;
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
   * Marks the letter `discarded`. A process letter whose instance is still failed on it ends the
   * instance with `ProcessAbandoned` in the same transaction, acted by the client's actor: the
   * events parked behind it stay unhandled, and later ones are no longer parked. Rejects a letter
   * that is missing, and with `DeadLetterSettledError` one that is no longer `failed`, or that a
   * retry settled while this ran.
   */
  discard(id: string): Promise<DeadLetter>;
}

export interface CreateDeadLettersArgs {
  readonly storage: AppStorage;
  readonly retries: DeadLetterRetry;
  readonly processes: Pick<ProcessDeadLetters, "parkedBehind" | "stillParked" | "abandon">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly errorText: ErrorText;
  readonly tracer: TracerFunction;
  /**
   * Who retries and discards, for the client bound to them.
   */
  readonly actor?: string | undefined;
  readonly recordAccess: RecordAccess;
  /**
   * Throws to refuse what a read would hand out, once it read: the access log records the
   * refusal as the read's outcome.
   */
  readonly vouch?: () => Promise<void>;
}

export interface CreateDeadLettersFunction {
  (args: CreateDeadLettersArgs): DeadLetters;
}

// The persons the error's text is sealed under, and those whose fields a payload holds.
const personsOf = (
  letter: Pick<StoredDeadLetter, "person" | "statePerson" | "readPersons" | "persons">,
): string[] => [...textPersons(letter), ...(letter.persons ?? []).map(({ person }) => person)];

export const createDeadLetters: CreateDeadLettersFunction = ({
  storage,
  retries,
  processes,
  clock,
  logger,
  errorText,
  tracer,
  actor,
  recordAccess,
  vouch,
}) => {
  const failedLetter = async (id: string): Promise<StoredDeadLetter> => {
    const letter = await storage.deadLetterStore.get(id);
    if (letter === null) throw runtimeText(new NotFoundError(`Dead letter "${id}" not found`));
    if (letter.status !== "failed") {
      throw new DeadLetterSettledError({ id, status: letter.status });
    }
    return letter;
  };

  // A forgotten person's error text and fields read as `null`, as an event's do; a restricted
  // person's stay sealed, read as `null` too, unless the view lets them out.
  const opened = async (
    { errorMessage, errorStack, payload, ...letter }: StoredDeadLetter,
    keyOf: KeyOfFunction = sealedKeys(storage.personalKeys),
    view: RestrictionView = "unrestricted",
    restricted: (person: string) => Promise<boolean> = restrictedAmong(storage.persons),
    letThrough: Set<string> = new Set(),
  ): Promise<DeadLetter> => {
    const sealed = (): DeadLetter => ({
      ...letter,
      errorMessage: null,
      ...(errorStack === undefined ? {} : { errorStack: null }),
      ...(payload === undefined ? {} : { payload: sealedLeft(payload) }),
      restricted: true,
    });
    for (const person of personsOf(letter)) {
      if (!(await restricted(person))) continue;
      if (view !== "all") return sealed();
      letThrough.add(person);
    }
    const open = openTextWith(keyOf);
    const fields =
      payload === undefined
        ? undefined
        : await openCommandPayload({ payload, keys: storage.personalKeys, keyOf });
    const kept = (fields?.opened ?? []).filter(({ retained }) => retained === true);
    if (view === "unrestricted" && kept.length > 0) return sealed();
    for (const { person } of kept) letThrough.add(person);
    return {
      ...letter,
      errorMessage: await open(errorMessage),
      ...(errorStack === undefined ? {} : { errorStack: await open(errorStack) }),
      ...(fields === undefined ? {} : { payload: fields.payload }),
    };
  };

  // The letter as its retry left it, with the `resolvedAt` the retry stored.
  const retried = async (letter: StoredDeadLetter): Promise<DeadLetter> => ({
    ...(await opened((await storage.deadLetterStore.get(letter.id)) ?? letter)),
    status: "retried",
  });

  const withParked = async (
    letter: StoredDeadLetter,
    keyOf?: KeyOfFunction,
    view?: RestrictionView,
    restricted?: (person: string) => Promise<boolean>,
    letThrough?: Set<string>,
  ): Promise<DeadLetter> => {
    const result = await opened(letter, keyOf, view, restricted, letThrough);
    if (letter.kind !== "process") return result;
    return { ...result, parked: await processes.parkedBehind(letter) };
  };

  // The restricted persons whose data a call opened on a basis, for its record: those a
  // restriction names, and those whose fields a forgetting kept. Only a call refused before it
  // read can name what is no basis.
  const restrictedRecord = (asked: unknown, letThrough: Iterable<string>) =>
    isRestrictionBasis(asked) ? { basis: asked, persons: [...letThrough] } : null;

  // Each call is recorded however it settles, with the letter it read: a retry that fails again
  // rejects with the handler's error, which may quote the person. One refused before it read the
  // letter, or that found none, names no one.
  const letterRecord =
    (
      operation: "deadLetters.get" | "deadLetters.retry" | "deadLetters.discard",
      id: string,
      letter: StoredDeadLetter | null,
      asked?: unknown,
      letThrough: ReadonlySet<string> = new Set(),
    ) =>
    (outcome: ReadOutcome, error: unknown) =>
      recordAccess({
        operation,
        detail: { letter: id },
        actor,
        persons: letter === null ? [] : personsOf(letter),
        outcome,
        error,
        restricted: restrictedRecord(asked, letThrough),
      });

  const calls: DeadLetters = {
    list: async (args, options) => {
      const asked = options?.includeRestricted;
      const letThrough = new Set<string>();
      const record =
        (letters: readonly StoredDeadLetter[]) => (outcome: ReadOutcome, error: unknown) =>
          recordAccess({
            operation: "deadLetters.list",
            detail: { letters: letters.length },
            actor,
            persons: letters.flatMap(personsOf),
            outcome,
            error,
            restricted: restrictedRecord(asked, letThrough),
          });
      const { includeRestricted, letters } = await checked(record([]), async () => ({
        includeRestricted: checkIncludeRestricted("deadLetters.list", asked),
        letters: await storage.deadLetterStore.list(args),
      }));
      const view = restrictionViewOf(includeRestricted);
      // Each person's key and restrictions read once for the whole page.
      const keyOf = sealedKeys(storage.personalKeys);
      const restricted = restrictedAmong(storage.persons);
      return recorded(record(letters), async () => {
        const read = await Promise.all(
          letters.map((letter) => withParked(letter, keyOf, view, restricted, letThrough)),
        );
        await vouch?.();
        return read;
      });
    },
    count: (args) => storage.deadLetterStore.count(args),
    get: async (id, options) => {
      const asked = options?.includeRestricted;
      const letThrough = new Set<string>();
      const { includeRestricted, letter } = await checked(
        letterRecord("deadLetters.get", id, null, asked),
        async () => ({
          includeRestricted: checkIncludeRestricted("deadLetters.get", asked),
          letter: await storage.deadLetterStore.get(id),
        }),
      );
      const record = letterRecord("deadLetters.get", id, letter, asked, letThrough);
      // Recorded as a query that matches no row is.
      if (letter === null) {
        await record("ok", undefined);
        return null;
      }
      return recorded(record, async () => {
        const read = await withParked(
          letter,
          undefined,
          restrictionViewOf(includeRestricted),
          undefined,
          letThrough,
        );
        await vouch?.();
        return read;
      });
    },
    retry: async (id) => {
      const letter = await checked(letterRecord("deadLetters.retry", id, null), () =>
        failedLetter(id),
      );
      return recorded(letterRecord("deadLetters.retry", id, letter), async () => {
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
        const settled = await retried(letter);
        if (letter.kind !== "process") return settled;
        return { ...settled, parked: await processes.stillParked(letter) };
      });
    },
    discard: async (id) => {
      const letter = await checked(letterRecord("deadLetters.discard", id, null), () =>
        failedLetter(id),
      );
      return recorded(letterRecord("deadLetters.discard", id, letter), async () => {
        const at = clock.now();
        if (letter.kind === "process") await processes.abandon({ letter, at, actor });
        else await storage.deadLetterStore.updateStatus(id, "discarded", at);
        logger.info("dead letter discarded", {
          id,
          kind: letter.kind,
          handler: letter.handler,
          ...actedBy(actor),
        });
        return { ...(await opened(letter)), status: "discarded", resolvedAt: at.toISOString() };
      });
    },
  };
  const withSpan =
    <Args extends unknown[], Result>(
      name: keyof DeadLetters,
      call: (...args: Args) => Promise<Result>,
    ) =>
    (...args: Args): Promise<Result> =>
      tracedOperation({
        tracer,
        operation: `deadLetters.${name}`,
        actor,
        errorText,
        run: () => call(...args),
      });
  return {
    list: withSpan("list", calls.list),
    count: withSpan("count", calls.count),
    get: withSpan("get", calls.get),
    retry: withSpan("retry", calls.retry),
    discard: withSpan("discard", calls.discard),
  };
};
