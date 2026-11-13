import type { PersonStore } from "../../adapter/storage/person-store.ts";
import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../../adapter/storage/subscriber-failure-store.ts";
import type { ErrorText } from "../../config/types.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
import { type RecordAccess, recorded } from "../personal-data/access.ts";
import { sealedKeys } from "../personal-data/commands.ts";
import { openTextWith } from "../personal-data/errors.ts";
import {
  checkIncludeRestricted,
  type IncludeRestrictedOptions,
  restrictedAmong,
  restrictionViewOf,
} from "../personal-data/restricted-reads.ts";
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
  /**
   * `true` when the event named a person whose processing is restricted and the text was left
   * sealed, reading as `null`: asked for with `includeRestricted`, it comes out opened.
   */
  readonly restricted?: true;
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
   * Every subscriber's last failure, by subscriber, resolved ones included. The text of one whose
   * event named a person whose processing is restricted stays sealed, unless `includeRestricted`
   * names the basis it is read on.
   */
  list(options?: IncludeRestrictedOptions): Promise<readonly SubscriberFailure[]>;
  /**
   * One subscriber's last failure, `null` when it never failed, as `list` gives it.
   */
  get(subscriber: string, options?: IncludeRestrictedOptions): Promise<SubscriberFailure | null>;
}

export interface CreateSubscriberFailuresArgs {
  readonly store: SubscriberFailureStore;
  readonly keys: PersonalKeys;
  readonly persons: Pick<PersonStore, "restrictions">;
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
  persons,
  actor,
  recordAccess,
  errorText,
}) => {
  const opened = async (
    { errorMessage, errorStack, ...failure }: StoredSubscriberFailure,
    open: (value: StoredSubscriberFailure["errorMessage"]) => Promise<string | null>,
    sealed: boolean,
  ): Promise<SubscriberFailure> =>
    sealed
      ? {
          ...failure,
          errorMessage: null,
          ...(errorStack === undefined ? {} : { errorStack: null }),
          restricted: true,
        }
      : {
          ...failure,
          errorMessage: await open(errorMessage),
          ...(errorStack === undefined ? {} : { errorStack: await open(errorStack) }),
        };

  // A failure's text is sealed under the person its event named alone, so only their restriction
  // keeps it sealed; `legal-obligation` opens none of it.
  // `letThrough` gathers the restricted persons whose text a basis opened, for the record.
  const read = (
    failures: readonly StoredSubscriberFailure[],
    includeRestricted: RestrictionBasis | undefined,
    letThrough: string[],
  ): Promise<SubscriberFailure[]> => {
    const restricted = restrictedAmong(persons);
    const opens = restrictionViewOf(includeRestricted) === "all";
    // Each person's key read once for the whole list.
    const open = openTextWith(sealedKeys(keys));
    return Promise.all(
      failures.map(async (failure) => {
        const sealed = failure.person !== null && (await restricted(failure.person));
        if (sealed && opens && failure.person !== null) letThrough.push(failure.person);
        return opened(failure, open, sealed && !opens);
      }),
    );
  };

  const restrictedRecord = (
    includeRestricted: RestrictionBasis | undefined,
    letThrough: readonly string[],
  ) => (includeRestricted === undefined ? null : { basis: includeRestricted, persons: letThrough });

  const list = async (options?: IncludeRestrictedOptions) => {
    const includeRestricted = checkIncludeRestricted(
      "subscriberFailures.list",
      options?.includeRestricted,
    );
    const failures = await store.list();
    const letThrough: string[] = [];
    return recorded(
      (outcome) =>
        recordAccess({
          operation: "subscriberFailures.list",
          detail: { failures: failures.length },
          actor,
          persons: personsOf(failures),
          outcome,
          restricted: restrictedRecord(includeRestricted, letThrough),
        }),
      () => read(failures, includeRestricted, letThrough),
    );
  };

  const get = async (
    subscriber: string,
    options?: IncludeRestrictedOptions,
  ): Promise<SubscriberFailure | null> => {
    const includeRestricted = checkIncludeRestricted(
      "subscriberFailures.get",
      options?.includeRestricted,
    );
    const failure = await store.get(subscriber);
    if (failure === null) return null;
    const letThrough: string[] = [];
    return recorded(
      (outcome) =>
        recordAccess({
          operation: "subscriberFailures.get",
          detail: { subscriber },
          actor,
          persons: personsOf([failure]),
          outcome,
          restricted: restrictedRecord(includeRestricted, letThrough),
        }),
      async () => (await read([failure], includeRestricted, letThrough))[0] as SubscriberFailure,
    );
  };

  return {
    list: (options) =>
      tracedOperation({
        operation: "subscriberFailures.list",
        actor,
        errorText,
        run: () => list(options),
      }),
    get: (subscriber, options) =>
      tracedOperation({
        operation: "subscriberFailures.get",
        actor,
        errorText,
        run: () => get(subscriber, options),
      }),
  };
};
