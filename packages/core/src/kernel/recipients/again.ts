import type { Storage } from "../../adapter/adapter.ts";
import type { ForgetLedgerEntry, LedgerDisclosure } from "../../adapter/storage/forget-ledger.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
} from "../../modules/bounda-events.ts";
import { transactRetrying } from "../personal-data/transact.ts";

export interface DiscloseAgainArgs {
  readonly storage: Pick<Storage, "transact">;
  readonly concurrencyRetries: number;
  readonly entry: ForgetLedgerEntry & { readonly disclosure: LedgerDisclosure };
}

export interface DiscloseAgainFunction {
  (args: DiscloseAgainArgs): Promise<boolean>;
}

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
      const forgottenSince = events.some((event) => {
        if (event.type !== PERSONAL_DATA_FORGOTTEN_EVENT || event.timestamp < forgottenAt) {
          return false;
        }
        const { categories, expired } = event.payload as PersonalDataForgottenPayload;
        return ([...categories, ...expired] as readonly string[]).includes(disclosure.category);
      });
      if (forgottenSince) return false;
      const added = await transaction.recipients.disclose(
        [{ person: personId, ...disclosure }],
        forgottenAt,
      );
      return added.length > 0;
    },
  });
