import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ForgetLedgerUnavailableError } from "../../contracts/errors.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { PersonalDataForgottenReason } from "../../modules/bounda-events.ts";
import type { BoundedForgetLedger } from "./forget-ledger.ts";

/**
 * The forgetting about to commit, as its `PersonalDataForgotten` will carry it.
 */
export interface ForgetIntention {
  readonly eventId: string;
  readonly forgottenAt: string;
  readonly reason: PersonalDataForgottenReason;
  /**
   * The keys the intention names, which the forgetting may destroy: one the person holds that is
   * not here was given to them after the intention was written. `undefined` without a ledger, and
   * for an entry that does not record them, which any key matches.
   */
  readonly fingerprints?: readonly string[] | undefined;
}

export interface IntendArgs {
  readonly personId: string;
  readonly reason: PersonalDataForgottenReason;
  /**
   * Where the key the person holds now is read, outside any transaction.
   */
  readonly keys: Pick<PersonalKeyStore, "get">;
}

export interface ForgetIntentions {
  /**
   * The intention of forgetting the person now, naming the key they hold, recorded in the ledger
   * before it resolves.
   */
  intend(args: IntendArgs): Promise<ForgetIntention>;
  /**
   * Records an entry in the ledger. A strict ledger that does not take it rejects with
   * `ForgetLedgerUnavailableError`; any other failure is logged, and the stream copies the
   * forgetting once it commits.
   */
  record(entry: ForgetLedgerEntry): Promise<void>;
}

export interface CreateForgetIntentionsArgs {
  /**
   * `null` without a ledger: nothing is recorded, and no key is read for it.
   */
  readonly ledger: BoundedForgetLedger | null;
  readonly strict: boolean;
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
  strict,
  ids,
  clock,
  logger,
}) => {
  const record = async (entry: ForgetLedgerEntry): Promise<void> => {
    if (ledger === null || (!strict && ledger.late())) return;
    try {
      await ledger.append([entry]);
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
    intend: async ({ personId, reason, keys }) => {
      const eventId = ids.next();
      const forgottenAt = clock.now().toISOString();
      if (ledger === null) return { eventId, forgottenAt, reason };
      const key = await keys.get(personId);
      const fingerprints = key === null ? [] : [key.fingerprint];
      await record({ personId, eventId, forgottenAt, reason, fingerprints });
      return { eventId, forgottenAt, reason, fingerprints };
    },
    record,
  };
};
