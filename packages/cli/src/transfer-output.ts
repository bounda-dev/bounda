import type { LegalRegime, PartialAdequacy } from "@bounda-dev/core";

export interface Transfer {
  readonly safeguard: string;
  readonly article: string;
  readonly regime: LegalRegime;
  readonly partialAdequacy: PartialAdequacy | null;
}

export interface FormatTransferFunction {
  (transfer: Transfer, holder: keyof typeof HOLDERS): string;
}

const HOLDERS = { recipient: "the recipient", provider: "the provider keeping it" } as const;

// Named by the regime the data goes to, not its location: data kept in "fedramp" goes to the US.
// A partial decision names whom it covers and what to verify of the recipient, or of the provider
// that keeps a store, as the transfer rests on it only while that holds.
export const formatTransfer: FormatTransferFunction = (
  { safeguard, article, regime, partialAdequacy },
  holder,
) =>
  `transferred ${regime === "anywhere" ? "anywhere" : `to ${regime === "EEA" ? "the EEA" : regime}`} under ${safeguard} (article ${article})${
    partialAdequacy === null
      ? ""
      : `, on ${partialAdequacy.decision}, for ${partialAdequacy.covers} alone: verify ${HOLDERS[holder]} is ${partialAdequacy.condition}`
  }`;
