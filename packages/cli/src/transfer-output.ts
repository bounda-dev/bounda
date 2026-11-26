import type { LegalRegime } from "@bounda-dev/core";

export interface Transfer {
  readonly safeguard: string;
  readonly article: string;
  readonly regime: LegalRegime;
}

export interface FormatTransferFunction {
  (transfer: Transfer): string;
}

// Named by the regime the data goes to, not its location: data kept in "fedramp" goes to the US.
export const formatTransfer: FormatTransferFunction = ({ safeguard, article, regime }) =>
  `transferred ${regime === "anywhere" ? "anywhere" : `to ${regime === "EEA" ? "the EEA" : regime}`} under ${safeguard} (article ${article})`;
