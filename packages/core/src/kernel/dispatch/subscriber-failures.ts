import type { PersonStore } from "../../adapter/storage/person-store.ts";
import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../../adapter/storage/subscriber-failure-store.ts";
import type { ErrorText } from "../../config/types.ts";
import type { ReadOutcome } from "../../modules/audit.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
import { checked, type RecordAccess, recorded } from "../personal-data/access.ts";
import { sealedKeys } from "../personal-data/commands.ts";
import { openTextWith, textPersons } from "../personal-data/errors.ts";
import {
  checkIncludeRestricted,
  type IncludeRestrictedOptions,
  isRestrictionBasis,
  restrictedAmong,
  restrictionViewOf,
} from "../personal-data/restricted-reads.ts";
import type { PersonalKeys } from "../personal-data/wrapped-keys.ts";
import { type TracerFunction, tracedOperation } from "../telemetry.ts";

/**
 * A subscriber's last failure, with the error's text opened: `null` once anyone it was sealed
 * under, the person the event named or one of `readPersons`, is forgotten.
 */
export interface SubscriberFailure
  extends Omit<StoredSubscriberFailure, "errorMessage" | "errorStack"> {
  readonly errorMessage: string | null;
  readonly errorStack?: string | null;
  /**
   * `true` when the text is sealed under a person whose processing is restricted and was left
   * sealed, reading as `null`: asked for with `includeRestricted`, it comes out opened.
   */
  readonly restricted?: true;
}

/**
 * The last failure of each subscriber, kept with its text whatever
 * `runtime.telemetry.errorText` says, since a projection's error otherwise leaves no text
 * anywhere. Each call that finds a failure hands its text out opened, so it is recorded in the
 * access log once it settles, naming the persons its text is sealed under, and rejects with what
 * the log's hook throws.
 */
export interface SubscriberFailures {
  /**
   * Every subscriber's last failure, by subscriber, resolved ones included. The text of one sealed
   * under a person whose processing is restricted stays sealed, unless `includeRestricted` names
   * the basis it is read on.
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
  readonly tracer: TracerFunction;
  /**
   * Throws to refuse what a read would hand out, once it read: the access log records the
   * refusal as the read's outcome.
   */
  readonly vouch?: () => Promise<void>;
}

export interface CreateSubscriberFailuresFunction {
  (args: CreateSubscriberFailuresArgs): SubscriberFailures;
}

// Everyone a failure's text is sealed under.
const personsOf = (failures: readonly StoredSubscriberFailure[]): string[] =>
  failures.flatMap(textPersons);

export const createSubscriberFailures: CreateSubscriberFailuresFunction = ({
  store,
  keys,
  persons,
  actor,
  recordAccess,
  errorText,
  tracer,
  vouch,
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

  // A failure's text is sealed under the person its event named and those its delivery read data
  // of, so only their restriction keeps it sealed; `erasure-exemption` opens none of it.
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
        const sealedUnder = personsOf([failure]);
        const holds = await Promise.all(sealedUnder.map((person) => restricted(person)));
        const held = sealedUnder.filter((_, index) => holds[index]);
        if (opens) letThrough.push(...held);
        return opened(failure, open, held.length > 0 && !opens);
      }),
    );
  };

  // Only a call refused before it read can name what is no basis.
  const restrictedRecord = (asked: unknown, letThrough: readonly string[]) =>
    isRestrictionBasis(asked) ? { basis: asked, persons: letThrough } : null;

  // Each call is recorded with the failures it read: refused before it read, or having found
  // nothing, it names no one.
  const list = async (options?: IncludeRestrictedOptions) => {
    const asked = options?.includeRestricted;
    const letThrough: string[] = [];
    const record = (failures: readonly StoredSubscriberFailure[]) => (outcome: ReadOutcome) =>
      recordAccess({
        operation: "subscriberFailures.list",
        detail: { failures: failures.length },
        actor,
        persons: personsOf(failures),
        outcome,
        restricted: restrictedRecord(asked, letThrough),
      });
    const { includeRestricted, failures } = await checked(record([]), async () => ({
      includeRestricted: checkIncludeRestricted("subscriberFailures.list", asked),
      failures: await store.list(),
    }));
    return recorded(record(failures), async () => {
      const listed = await read(failures, includeRestricted, letThrough);
      await vouch?.();
      return listed;
    });
  };

  const get = async (
    subscriber: string,
    options?: IncludeRestrictedOptions,
  ): Promise<SubscriberFailure | null> => {
    const asked = options?.includeRestricted;
    const letThrough: string[] = [];
    const record = (failures: readonly StoredSubscriberFailure[]) => (outcome: ReadOutcome) =>
      recordAccess({
        operation: "subscriberFailures.get",
        detail: { subscriber },
        actor,
        persons: personsOf(failures),
        outcome,
        restricted: restrictedRecord(asked, letThrough),
      });
    const { includeRestricted, failure } = await checked(record([]), async () => ({
      includeRestricted: checkIncludeRestricted("subscriberFailures.get", asked),
      failure: await store.get(subscriber),
    }));
    // Recorded as a query that matches no row is.
    if (failure === null) {
      await record([])("ok");
      return null;
    }
    return recorded(record([failure]), async () => {
      const [first] = await read([failure], includeRestricted, letThrough);
      await vouch?.();
      return first as SubscriberFailure;
    });
  };

  return {
    list: (options) =>
      tracedOperation({
        tracer,
        operation: "subscriberFailures.list",
        actor,
        errorText,
        run: () => list(options),
      }),
    get: (subscriber, options) =>
      tracedOperation({
        tracer,
        operation: "subscriberFailures.get",
        actor,
        errorText,
        run: () => get(subscriber, options),
      }),
  };
};
