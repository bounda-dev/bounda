import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../../adapter/storage/subscriber-failure-store.ts";
import type { ErrorText } from "../../config/types.ts";
import { type RecordAccess, recorded } from "../personal-data/access.ts";
import { sealedKeys } from "../personal-data/commands.ts";
import { openTextWith } from "../personal-data/errors.ts";
import type { PersonalKeys } from "../personal-data/wrapped-keys.ts";
import { tracedOperation } from "../telemetry.ts";

/**
 * A subscriber's last failure, with the error's text opened: `null` once the person the event
 * named, under whose key it was sealed, is forgotten.
 */
export interface SubscriberFailure
  extends Omit<StoredSubscriberFailure, "errorMessage" | "errorStack"> {
  readonly errorMessage: string | null;
  readonly errorStack?: string | null;
}

/**
 * The last failure of each subscriber, kept with its text whatever
 * `runtime.telemetry.errorText` says, since a projection's error otherwise leaves no text
 * anywhere. Each call that finds a failure hands its text out opened, so it is recorded in the
 * access log once it settles, naming the person the event named, and rejects with what the log's
 * hook throws.
 */
export interface SubscriberFailures {
  /**
   * Every subscriber's last failure, by subscriber, resolved ones included.
   */
  list(): Promise<readonly SubscriberFailure[]>;
  /**
   * One subscriber's last failure, `null` when it never failed.
   */
  get(subscriber: string): Promise<SubscriberFailure | null>;
}

export interface CreateSubscriberFailuresArgs {
  readonly store: SubscriberFailureStore;
  readonly keys: PersonalKeys;
  readonly actor: string | undefined;
  readonly recordAccess: RecordAccess;
  readonly errorText: ErrorText;
}

export interface CreateSubscriberFailuresFunction {
  (args: CreateSubscriberFailuresArgs): SubscriberFailures;
}

const personsOf = (failures: readonly StoredSubscriberFailure[]): string[] =>
  failures.flatMap(({ person }) => (person === null ? [] : [person]));

export const createSubscriberFailures: CreateSubscriberFailuresFunction = ({
  store,
  keys,
  actor,
  recordAccess,
  errorText,
}) => {
  const opened = async (
    { errorMessage, errorStack, ...failure }: StoredSubscriberFailure,
    open: (value: StoredSubscriberFailure["errorMessage"]) => Promise<string | null>,
  ): Promise<SubscriberFailure> => ({
    ...failure,
    errorMessage: await open(errorMessage),
    ...(errorStack === undefined ? {} : { errorStack: await open(errorStack) }),
  });

  const list = async (): Promise<readonly SubscriberFailure[]> => {
    const failures = await store.list();
    // Each person's key read once for the whole list.
    const open = openTextWith(sealedKeys(keys));
    return recorded(
      (outcome) =>
        recordAccess({
          operation: "subscriberFailures.list",
          detail: { failures: failures.length },
          actor,
          persons: personsOf(failures),
          outcome,
        }),
      () => Promise.all(failures.map((failure) => opened(failure, open))),
    );
  };

  const get = async (subscriber: string): Promise<SubscriberFailure | null> => {
    const failure = await store.get(subscriber);
    if (failure === null) return null;
    return recorded(
      (outcome) =>
        recordAccess({
          operation: "subscriberFailures.get",
          detail: { subscriber },
          actor,
          persons: personsOf([failure]),
          outcome,
        }),
      () => opened(failure, openTextWith(sealedKeys(keys))),
    );
  };

  return {
    list: () =>
      tracedOperation({ operation: "subscriberFailures.list", actor, errorText, run: list }),
    get: (subscriber) =>
      tracedOperation({
        operation: "subscriberFailures.get",
        actor,
        errorText,
        run: () => get(subscriber),
      }),
  };
};
