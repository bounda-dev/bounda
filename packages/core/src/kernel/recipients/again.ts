import type { Storage } from "../../adapter/adapter.ts";
import type { ForgetLedgerEntry, LedgerDisclosure } from "../../adapter/storage/forget-ledger.ts";
import type { Disclosure } from "../../adapter/storage/recipient-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
} from "../../modules/bounda-events.ts";
import { transactRetrying } from "../personal-data/transact.ts";
import { disclosureOfLedger } from "./transfer.ts";

export interface DiscloseAgainArgs {
  readonly storage: Pick<Storage, "transact">;
  readonly concurrencyRetries: number;
  readonly entry: ForgetLedgerEntry & { readonly disclosure: LedgerDisclosure };
}

export interface DiscloseAgainFunction {
  (args: DiscloseAgainArgs): Promise<boolean>;
}

export interface ForgottenSinceFunction {
  (
    events: readonly StoredEvent[],
    entry: Pick<ForgetLedgerEntry, "forgottenAt"> & { readonly disclosure: LedgerDisclosure },
  ): boolean;
}

// Whether the person's events hold a forgetting of the disclosure's category at or after it, which
// told the recipient and removed it from the store.
export const forgottenSince: ForgottenSinceFunction = (events, { forgottenAt, disclosure }) =>
  events.some((event) => {
    if (event.type !== PERSONAL_DATA_FORGOTTEN_EVENT || event.timestamp < forgottenAt) {
      return false;
    }
    const { categories, expired } = event.payload as PersonalDataForgottenPayload;
    return ([...categories, ...expired] as readonly string[]).includes(disclosure.category);
  });

export interface DisclosureHeldFunction {
  (held: readonly Disclosure[], disclosure: LedgerDisclosure): boolean;
}

// Whether the store holds the disclosure, as it was recorded.
export const disclosureHeld: DisclosureHeldFunction = (held, disclosure) =>
  held.some(
    (each) =>
      each.port === disclosure.port &&
      each.recipient === disclosure.recipient &&
      each.kind === disclosure.kind &&
      each.country === disclosure.country &&
      each.safeguard === (disclosure.transfer?.safeguard ?? null) &&
      each.category === disclosure.category,
  );

/**
 * Records again a disclosure the ledger holds and the store lost, at the time it was first
 * recorded, and resolves whether it did: unless the store holds it, or a forgetting of its
 * category came after it, whose event told the recipient already and which removed it.
 */
export const discloseAgain: DiscloseAgainFunction = ({ storage, concurrencyRetries, entry }) =>
  transactRetrying({
    storage,
    concurrencyRetries,
    work: async (transaction) => {
      const { personId, forgottenAt, disclosure } = entry;
      const { events } = await transaction.eventStore.load({
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: personId,
      });
      if (forgottenSince(events, entry)) return false;
      const added = await transaction.recipients.disclose(
        [disclosureOfLedger(personId, disclosure)],
        forgottenAt,
      );
      return added.length > 0;
    },
  });
