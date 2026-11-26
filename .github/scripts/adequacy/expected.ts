// What the Commission's list holds besides the codes of `ADEQUATE_COUNTRIES`, kept here because
// Bounda's types have no place for it. Update it with `ADEQUATE_COUNTRIES` when the list changes.
import type { AdequateCountry, CountryCode } from "../../../packages/core/src/modules/recipient.ts";

// Entries that are no country, and so no `DataLocation`: an app cannot keep data there.
export const ORGANISATIONS = ["European Patent Organisation"] as const;

export type Organisation = (typeof ORGANISATIONS)[number];

// The words the list writes after a name, exactly: they say what the decision covers (some
// organisations only, a renewal). A name without them has a decision for the whole country.
export const SCOPES: Readonly<Partial<Record<AdequateCountry | Organisation, string>>> = {
  CA: "(commercial organisations)",
  GB: "under the GDPR and the LED, as amended in December 2025 through one renewal decision under the GDPR and one renewal decision under the LED",
  US: "(commercial organisations participating in the EU-US Data Privacy Framework)",
};

// Names the list uses where Unicode's English name differs.
export const ALIASES: Readonly<Record<string, CountryCode>> = {
  "Republic of Korea": "KR",
};
