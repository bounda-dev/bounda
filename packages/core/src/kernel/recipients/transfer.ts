import type { LedgerDisclosure } from "../../adapter/storage/forget-ledger.ts";
import type { Disclosure } from "../../adapter/storage/recipient-store.ts";
import { partialAdequacyOf, regimeOf } from "../../modules/data-location.ts";
import {
  type CountryCode,
  type RecipientTransfer,
  TRANSFER_ARTICLES,
  type TransferSafeguard,
} from "../../modules/recipient.ts";

export interface RecipientTransferOfFunction {
  (country: CountryCode, safeguard: TransferSafeguard | null): RecipientTransfer | null;
}

// A recipient declares a safeguard only for a country outside the European Economic Area. The
// partial decision follows from the country, as the declaration's `adequacyScope` had to name it,
// so a disclosure recorded with its country and safeguard alone still tells of it.
export const recipientTransferOf: RecipientTransferOfFunction = (country, safeguard) => {
  if (safeguard === null) return null;
  const regime = regimeOf(country.toLowerCase() as Lowercase<CountryCode>);
  return {
    safeguard,
    article: TRANSFER_ARTICLES[safeguard],
    regime,
    partialAdequacy: safeguard === "adequacy" ? partialAdequacyOf(regime) : null,
  };
};

export interface LedgerDisclosureOfRecordedFunction {
  (disclosure: Omit<Disclosure, "person">): LedgerDisclosure;
}

// The store keeps a declared recipient's country and safeguard, which `build.ts` checked.
export const ledgerDisclosureOfRecorded: LedgerDisclosureOfRecordedFunction = ({
  port,
  recipient,
  kind,
  country,
  safeguard,
  category,
}) => ({
  port,
  recipient,
  kind,
  country,
  transfer: recipientTransferOf(country as CountryCode, safeguard as TransferSafeguard | null),
  category,
});

export interface DisclosureOfLedgerFunction {
  (person: string, disclosure: LedgerDisclosure): Disclosure;
}

export const disclosureOfLedger: DisclosureOfLedgerFunction = (
  person,
  { port, recipient, kind, country, transfer, category },
) => ({
  person,
  port,
  recipient,
  kind,
  country,
  safeguard: transfer?.safeguard ?? null,
  category,
});
