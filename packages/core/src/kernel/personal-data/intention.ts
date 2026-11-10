import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type {
  HeldPersonalKey,
  PersonalKeyStore,
} from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ForgetLedgerUnavailableError } from "../../contracts/errors.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { PersonalDataForgottenReason } from "../../modules/bounda-events.ts";
import type { ForgetScope } from "./forget.ts";
import type { BoundedForgetLedger } from "./forget-ledger.ts";

/**
 * The forgetting about to commit, as its `PersonalDataForgotten` will carry it.
 */
export interface ForgetIntention {
  readonly eventId: string;
  readonly forgottenAt: string;
  readonly reason: PersonalDataForgottenReason;
  /**
   * The keys the intention covers, which the forgetting may destroy or retain: one in force the
   * person holds in its scope that is not here was given to them after the intention was written.
   * `undefined` without a ledger, and for an entry that does not record them, which any key
   * matches.
   */
  readonly fingerprints?: readonly string[] | undefined;
}

export interface IntendArgs {
  readonly personId: string;
  readonly reason: PersonalDataForgottenReason;
  readonly scope: ForgetScope;
  /**
   * Where the keys the person holds now are read, outside any transaction.
   */
  readonly keys: Pick<PersonalKeyStore, "list">;
}

export interface ForgetIntentions {
  /**
   * The intention of forgetting what `scope` covers of the person now, naming the keys it covers,
   * recorded in the ledger before it resolves.
   */
  intend(args: IntendArgs): Promise<ForgetIntention>;
  /**
   * Records an entry in the ledger. A strict ledger that does not take it rejects with
   * `ForgetLedgerUnavailableError`; any other failure is logged, and the stream copies the
   * forgetting once it commits.
   */
  record(entry: ForgetLedgerEntry): Promise<void>;
}

export interface CoveredByFunction {
  (scope: ForgetScope, held: readonly HeldPersonalKey[]): readonly HeldPersonalKey[];
}

/**
 * The keys a forgetting of `scope` covers among those the person holds: every one in force for the
 * person as a whole, those in force of the categories named, or the keys named by fingerprint,
 * whatever they are.
 */
export const coveredBy: CoveredByFunction = (scope, held) =>
  scope.kind === "keys"
    ? held.filter(({ key }) => scope.fingerprints.includes(key.fingerprint))
    : held.filter(
        ({ category, retainedSince }) =>
          retainedSince === null && (scope.kind === "whole" || scope.categories.includes(category)),
      );

// What the ledger keeps a forgetting asked for: the categories of the keys in force it names by
// fingerprint, so a retention's comes back as the categories it ended, and none for the keys an
// earlier forgetting retained, which the retention ends again on its own.
const askedFor = (
  scope: ForgetScope,
  covered: readonly HeldPersonalKey[],
): readonly string[] | null => {
  if (scope.kind === "whole") return null;
  if (scope.kind === "categories") return scope.categories;
  return [
    ...new Set(
      covered.filter(({ retainedSince }) => retainedSince === null).map(({ category }) => category),
    ),
  ];
};

export interface CreateForgetIntentionsArgs {
  /**
   * `null` without a ledger: nothing is recorded, and no key is read for it.
   */
  readonly ledger: {
    readonly store: BoundedForgetLedger;
    readonly strict: boolean;
  } | null;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateForgetIntentionsFunction {
  (args: CreateForgetIntentionsArgs): ForgetIntentions;
}

/**
 * Every forgetting writes its intention first, so the ledger holds it whether or not the commit
 * happens: an intention whose commit does not happen is committed by the next reconciliation,
 * since forgetting is what was asked. While a call given up for its timeout is still pending, a
 * ledger that is not strict is skipped, rather than each forgetting waiting on one that hangs.
 */
export const createForgetIntentions: CreateForgetIntentionsFunction = ({
  ledger,
  ids,
  clock,
  logger,
}) => {
  const record = async (entry: ForgetLedgerEntry): Promise<void> => {
    if (ledger === null) return;
    const { store, strict } = ledger;
    if (!strict && store.late()) return;
    try {
      await store.append([entry]);
    } catch (error) {
      if (strict) throw new ForgetLedgerUnavailableError(error);
      logger.warn(
        "forget ledger did not take the forgetting; it commits, and the stream copies it",
        {
          error,
        },
      );
    }
  };
  return {
    intend: async ({ personId, reason, scope, keys }) => {
      const eventId = ids.next();
      const forgottenAt = clock.now().toISOString();
      if (ledger === null) return { eventId, forgottenAt, reason };
      const covered = coveredBy(scope, await keys.list(personId));
      const fingerprints = covered.map(({ key }) => key.fingerprint);
      await record({
        personId,
        categories: askedFor(scope, covered),
        eventId,
        forgottenAt,
        reason,
        fingerprints,
      });
      return { eventId, forgottenAt, reason, fingerprints };
    },
    record,
  };
};
