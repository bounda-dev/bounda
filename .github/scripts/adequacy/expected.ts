// What the Commission's list holds besides the codes of `ADEQUATE_COUNTRIES`, kept here because
// Bounda's types have no place for it. Update it with `ADEQUATE_COUNTRIES` when the list changes.
import {
  type AdequateCountry,
  type CountryCode,
  PARTIAL_ADEQUACY,
} from "../../../packages/core/src/modules/recipient.ts";

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

// The decision of each entry, by its CELEX number on EUR-Lex: the act whose in-force status and
// end of validity EUR-Lex records. The partial decisions' come from PARTIAL_ADEQUACY.
export const DECISIONS: Readonly<Record<AdequateCountry | Organisation, string>> = {
  AD: "32010D0625",
  AR: "32003D0490",
  BR: "32026D0179",
  CA: PARTIAL_ADEQUACY.CA.celex,
  CH: "32000D0518",
  FO: "32010D0146",
  GB: "32021D1772",
  GG: "32003D0821",
  IL: "32011D0061",
  IM: "32004D0411",
  JE: "32008D0393",
  JP: "32019D0419",
  KR: "32022D0254",
  NZ: "32013D0065",
  US: PARTIAL_ADEQUACY.US.celex,
  UY: "32012D0484",
  "European Patent Organisation": "32025D1382",
};

// Acts in force whose title reads as an adequacy decision, and that are no decision of the list,
// with what each does.
export const OTHER_ACTS: Readonly<Record<string, string>> = {
  "32000D0519": "Hungary, in the European Economic Area since 2004",
  "32011D0197":
    "Japan, under Regulation (EC) No 45/2001, for the Commission's transfers to Japanese customs",
  "32016D2295": "amends the decisions under Directive 95/46/EC on supervisory authorities' powers",
  "32021D1773": "the United Kingdom under Directive (EU) 2016/680, for law enforcement",
  "32025D1225": "amends 32021D1773, its extension of June 2025",
  "32025D1226": "amends 32021D1772, its extension of June 2025",
  "32025D2571": "amends 32021D1773, its renewal of December 2025",
  "32025D2574": "amends 32021D1772, its renewal of December 2025",
};
