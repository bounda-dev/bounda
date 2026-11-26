import { regimeOf } from "../../modules/data-location.ts";
import {
  type CountryCode,
  type RecipientTransfer,
  TRANSFER_ARTICLES,
  type TransferSafeguard,
} from "../../modules/recipient.ts";

export interface RecipientTransferOfFunction {
  (country: CountryCode, safeguard: TransferSafeguard | null): RecipientTransfer | null;
}

// A recipient declares a safeguard only for a country outside the European Economic Area.
export const recipientTransferOf: RecipientTransferOfFunction = (country, safeguard) =>
  safeguard === null
    ? null
    : {
        safeguard,
        article: TRANSFER_ARTICLES[safeguard],
        regime: regimeOf(country.toLowerCase() as Lowercase<CountryCode>),
      };
