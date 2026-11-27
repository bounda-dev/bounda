import type {
  PersonalDataForgottenEvent,
  PersonalDataRedactedEvent,
  ProcessingRestrictedEvent,
  ProcessingRestrictionLiftAnnouncedEvent,
  ProcessingRestrictionLiftedEvent,
  TenantForgottenEvent,
} from "./bounda-events.ts";
import type { LegalRegime } from "./data-location.ts";
import type { LegalBasis, PersonalCategoryName } from "./personal-data.ts";

/**
 * Who a recipient is to the controller, as the GDPR tells them apart: a `processor` that processes
 * the data on the app's behalf (article 28), a `joint-controller` that decides with it why and how
 * (article 26), or a `third-party` that receives it for purposes of its own (article 4(10)).
 */
export type RecipientKind = "processor" | "joint-controller" | "third-party";

/**
 * Every kind of recipient.
 */
export const RECIPIENT_KINDS: readonly RecipientKind[] = [
  "processor",
  "joint-controller",
  "third-party",
];

/**
 * What allows a transfer to a country outside the European Economic Area, as chapter V of the GDPR
 * names them: an `adequacy` decision (article 45), `standard-contractual-clauses` (article
 * 46(2)(c)), `binding-corporate-rules` (article 47), an approved `code-of-conduct` (article
 * 46(2)(e)), a `certification` (article 46(2)(f)), or a `derogation` for a specific situation
 * (article 49).
 */
export type TransferSafeguard =
  | "adequacy"
  | "standard-contractual-clauses"
  | "binding-corporate-rules"
  | "code-of-conduct"
  | "certification"
  | "derogation";

/**
 * Every safeguard, in the order of chapter V.
 */
export const TRANSFER_SAFEGUARDS: readonly TransferSafeguard[] = [
  "adequacy",
  "standard-contractual-clauses",
  "binding-corporate-rules",
  "code-of-conduct",
  "certification",
  "derogation",
];

/**
 * The article of the GDPR each safeguard rests on.
 */
export const TRANSFER_ARTICLES: Readonly<Record<TransferSafeguard, string>> = {
  adequacy: "45",
  "standard-contractual-clauses": "46(2)(c)",
  "binding-corporate-rules": "47",
  "code-of-conduct": "46(2)(e)",
  certification: "46(2)(f)",
  derogation: "49",
};

/**
 * A transfer of personal data to a recipient outside the European Economic Area: the safeguard it
 * rests on, the article of the GDPR that safeguard rests on, and the legal regime the data goes to,
 * as `regimeOf` names the recipient's country.
 */
export interface RecipientTransfer {
  readonly safeguard: TransferSafeguard;
  readonly article: string;
  readonly regime: LegalRegime;
  /**
   * The decision of `PARTIAL_ADEQUACY` the transfer rests on, whose `condition` you verify of the
   * recipient; `null` unless the safeguard is `adequacy` in a country of `PARTIAL_ADEQUACY`.
   */
  readonly partialAdequacy: PartialAdequacy | null;
}

/**
 * What allows a store, such as the tenant key store or a read model's database, to keep data in
 * another jurisdiction than `storage`: a safeguard of articles 45 to 47. A `derogation` of article
 * 49 covers occasional transfers only, never data kept somewhere for as long as the app runs.
 */
export type StoreSafeguard = Exclude<TransferSafeguard, "derogation">;

/**
 * Every safeguard a store may declare, in the order of chapter V.
 */
export const STORE_SAFEGUARDS: readonly StoreSafeguard[] = [
  "adequacy",
  "standard-contractual-clauses",
  "binding-corporate-rules",
  "code-of-conduct",
  "certification",
];

/**
 * The countries of the European Economic Area, by their ISO 3166-1 alpha-2 code, and the parts of
 * them ISO 3166-1 codes apart where the GDPR applies as in the rest of the country: the Åland
 * Islands (`AX`, Finland) and the outermost regions of France (`GF`, `GP`, `MF`, `MQ`, `RE`, `YT`).
 * A transfer to one of them needs no safeguard.
 */
export const EEA_COUNTRIES = [
  "AT",
  "AX",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GF",
  "GP",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MF",
  "MQ",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RE",
  "RO",
  "SE",
  "SI",
  "SK",
  "YT",
] as const;

/**
 * Every ISO 3166-1 alpha-2 country code.
 */
export const COUNTRY_CODES = [
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
] as const;

/**
 * The countries with an adequacy decision of the European Commission under article 45 of the GDPR,
 * as of November 2026, by their ISO 3166-1 alpha-2 code. Only these take the `adequacy` safeguard.
 * The decisions for Canada and the United States cover some recipients alone (`PARTIAL_ADEQUACY`),
 * so a transfer there rests on `adequacy` only with the `adequacyScope` that says the recipient or
 * the provider is one of them.
 */
export const ADEQUATE_COUNTRIES = [
  "AD",
  "AR",
  "BR",
  "CA",
  "CH",
  "FO",
  "GB",
  "GG",
  "IL",
  "IM",
  "JE",
  "JP",
  "KR",
  "NZ",
  "US",
  "UY",
] as const;

/**
 * A country by its ISO 3166-1 alpha-2 code.
 */
export type CountryCode = (typeof COUNTRY_CODES)[number];

/**
 * A country of the European Economic Area.
 */
export type EeaCountry = (typeof EEA_COUNTRIES)[number];

/**
 * A country with an adequacy decision of the European Commission.
 */
export type AdequateCountry = (typeof ADEQUATE_COUNTRIES)[number];

/**
 * An adequacy decision that covers some recipients in its country alone, as `PARTIAL_ADEQUACY`
 * gives each.
 */
export interface PartialAdequacy<Scope extends string = string> {
  /**
   * What a store or a recipient resting on the decision declares as its `adequacyScope`.
   */
  readonly scope: Scope;
  /**
   * The decision, as the Official Journal names it.
   */
  readonly decision: string;
  /**
   * The decision's CELEX number, by which EUR-Lex finds it.
   */
  readonly celex: string;
  /**
   * Whom the decision covers, as it says.
   */
  readonly covers: string;
  /**
   * What the recipient, or the provider that keeps a store, must be for a transfer to rest on the
   * decision, which you verify before it does and as long as it does: outside the decision's
   * scope, the transfer needs another safeguard.
   */
  readonly condition: string;
}

/**
 * The adequacy decisions of `ADEQUATE_COUNTRIES` that cover some recipients in their country alone,
 * by its ISO 3166-1 alpha-2 code, as of November 2026: Canada's, for recipients subject to PIPEDA,
 * and the United States', for organisations on the Data Privacy Framework List. A transfer to one
 * of these countries rests on `adequacy` only when it declares the decision's `scope` as its
 * `adequacyScope`, and the record of processing and the exports name the decision's `condition`.
 */
export const PARTIAL_ADEQUACY: {
  readonly CA: PartialAdequacy<"pipeda">;
  readonly US: PartialAdequacy<"data-privacy-framework">;
} = {
  CA: {
    scope: "pipeda",
    decision: "Commission Decision 2002/2/EC",
    celex: "32002D0002",
    covers:
      "recipients subject to the Personal Information Protection and Electronic Documents Act (PIPEDA)",
    condition:
      "subject to PIPEDA for the data, as a private-sector organisation is for personal information it collects, uses or discloses in the course of commercial activities",
  },
  US: {
    scope: "data-privacy-framework",
    decision: "Commission Implementing Decision (EU) 2023/1795",
    celex: "32023D1795",
    covers:
      "organisations in the United States included in the Data Privacy Framework List of the US Department of Commerce",
    condition:
      "on the Data Privacy Framework List, with an active certification that covers the data transferred, human resources data or other",
  },
};

/**
 * A country whose adequacy decision covers some recipients alone, a key of `PARTIAL_ADEQUACY`.
 */
export type PartiallyAdequateCountry = keyof typeof PARTIAL_ADEQUACY;

/**
 * The `adequacyScope` that a transfer to `Country`, one of `PartiallyAdequateCountry`, declares to
 * rest on its adequacy decision; every country's scope when `Country` is left out.
 */
export type AdequacyScope<Country extends PartiallyAdequateCountry = PartiallyAdequateCountry> =
  (typeof PARTIAL_ADEQUACY)[Country]["scope"];

interface RecipientIdentity<Category extends string> {
  /**
   * Who receives the data, as the person is told: the provider's name, `"Mailchimp"`.
   */
  readonly name: string;
  readonly kind: RecipientKind;
  /**
   * The categories of personal data the port sends it: what a run opened of these categories is
   * recorded as disclosed when it calls the port, and nothing else is.
   */
  readonly categories: readonly [Category, ...Category[]];
  /**
   * The keys the port had before a rename, `"<aggregate or read model>.<port>"`: what was disclosed
   * under them is this recipient's, and so is the telling of it.
   */
  readonly formerly?: readonly string[];
}

/**
 * The safeguard and `adequacyScope` of a transfer to a country of `PARTIAL_ADEQUACY`.
 */
type PartialAdequacyDeclaration = {
  readonly [Country in PartiallyAdequateCountry]:
    | {
        readonly country: Country;
        readonly safeguard: "adequacy";
        /**
         * The part of the country's adequacy decision the recipient falls in, its
         * `PARTIAL_ADEQUACY` scope: declaring it says you verified the decision's `condition` of
         * the recipient, as the record of processing and the exports then name it. Without it,
         * the transfer rests on another safeguard.
         */
        readonly adequacyScope: AdequacyScope<Country>;
      }
    | {
        readonly country: Country;
        readonly safeguard: Exclude<TransferSafeguard, "adequacy">;
        readonly adequacyScope?: never;
      };
}[PartiallyAdequateCountry];

/**
 * What a port module exports as `recipient` when the port sends personal data out: who receives
 * it, where, and which categories. A country outside the European Economic Area takes the
 * safeguard its transfer rests on, `adequacy` only when it is one of `ADEQUATE_COUNTRIES`, and
 * there, in a country of `PARTIAL_ADEQUACY`, only beside the `adequacyScope` that says the
 * recipient falls in its decision; one inside takes none.
 */
export type RecipientDeclaration<Category extends string = PersonalCategoryName> =
  RecipientIdentity<Category> &
    (
      | { readonly country: EeaCountry; readonly safeguard?: never; readonly adequacyScope?: never }
      | {
          readonly country: Exclude<AdequateCountry, PartiallyAdequateCountry>;
          readonly safeguard: TransferSafeguard;
          readonly adequacyScope?: never;
        }
      | PartialAdequacyDeclaration
      | {
          readonly country: Exclude<CountryCode, EeaCountry | AdequateCountry>;
          readonly safeguard: Exclude<TransferSafeguard, "adequacy">;
          readonly adequacyScope?: never;
        }
    );

/**
 * A recipient one of the runtime's events names, to be told of it: the port, by
 * `"<aggregate or read model>.<port>"`, and, of the categories it was disclosed, those the change
 * touches. `retained` are those a forgetting kept under an erasure exemption instead, restricted;
 * `presumed` is `true` when the disclosure is not recorded but cannot be ruled out, as for a
 * recipient declared after the person's data already existed.
 */
export interface NotifiedRecipient {
  readonly port: string;
  readonly categories: readonly PersonalCategoryName[];
  readonly retained: readonly PersonalCategoryName[];
  readonly presumed: boolean;
}

/**
 * What every handler of a recipient receives besides its event and its port.
 */
interface RecipientNoticeBase {
  /**
   * Of the categories disclosed to the recipient, those the change touches.
   */
  readonly categories: readonly PersonalCategoryName[];
  /**
   * `true` when the disclosure is presumed rather than recorded.
   */
  readonly presumed: boolean;
  /**
   * The same on every automatic retry for this event and recipient, new when an operator retries
   * the dead letter.
   */
  readonly idempotencyKey: string;
  /**
   * Aborted when the handler runs out of time.
   */
  readonly signal: AbortSignal;
}

/**
 * The arguments of one of a recipient's handlers: the event, what of it concerns the recipient,
 * and the port itself, under its name.
 */
export type RecipientNoticeArgs<
  Event,
  Ports extends object,
  Extra extends object = Record<never, never>,
> = RecipientNoticeBase & { readonly event: Event } & Extra & Readonly<Ports>;

/**
 * `onPersonalDataForgotten`'s arguments: `retained` are the categories disclosed that a forgetting
 * kept under an erasure exemption, to restrict rather than erase.
 */
export type RecipientForgottenArgs<Ports extends object> = RecipientNoticeArgs<
  PersonalDataForgottenEvent,
  Ports,
  { readonly retained: readonly PersonalCategoryName[] }
>;

export type RecipientRestrictedArgs<Ports extends object> = RecipientNoticeArgs<
  ProcessingRestrictedEvent,
  Ports
>;

export type RecipientLiftAnnouncedArgs<Ports extends object> = RecipientNoticeArgs<
  ProcessingRestrictionLiftAnnouncedEvent,
  Ports
>;

export type RecipientLiftedArgs<Ports extends object> = RecipientNoticeArgs<
  ProcessingRestrictionLiftedEvent,
  Ports
>;

export type RecipientRedactedArgs<Ports extends object> = RecipientNoticeArgs<
  PersonalDataRedactedEvent,
  Ports
>;

/**
 * `onTenantForgotten`'s arguments: `categories` are every category disclosed to the recipient, and
 * `persons` lists, in pages, the ids of the persons whose data its port disclosed, as the store
 * recorded them: erase every one; with `presumed`, it may hold others' too.
 */
export type RecipientTenantForgottenArgs<Ports extends object> = RecipientNoticeArgs<
  TenantForgottenEvent,
  Ports,
  { readonly persons: () => AsyncIterable<string> }
>;

/**
 * The handlers a recipient's port module exports, by the event each tells it of.
 */
export const RECIPIENT_HANDLERS = {
  onPersonalDataForgotten: "PersonalDataForgotten",
  onProcessingRestricted: "ProcessingRestricted",
  onProcessingRestrictionLiftAnnounced: "ProcessingRestrictionLiftAnnounced",
  onProcessingRestrictionLifted: "ProcessingRestrictionLifted",
  onPersonalDataRedacted: "PersonalDataRedacted",
  onTenantForgotten: "TenantForgotten",
} as const;

export type RecipientHandlerName = keyof typeof RECIPIENT_HANDLERS;

/**
 * The shape of a port module that declares a recipient, which the generated registry checks it
 * against: the declaration and one handler per event the recipient is told of.
 */
export type RecipientModule = {
  readonly recipient: RecipientDeclaration<string>;
} & { readonly [Name in RecipientHandlerName]: (args: never) => unknown };

type MissingHandler<Module> = {
  [Name in RecipientHandlerName]: Module extends {
    readonly [Key in Name]: (args: never) => unknown;
  }
    ? never
    : Name;
}[RecipientHandlerName];

type SyncMethods<Port> =
  | (Port extends (...args: never) => infer Result
      ? Result extends PromiseLike<unknown>
        ? never
        : "itself"
      : never)
  | {
      [Key in keyof Port]: Port[Key] extends (...args: never) => infer Result
        ? Result extends PromiseLike<unknown>
          ? never
          : Key
        : never;
    }[keyof Port];

/**
 * `true` when the port module `Module` of the port `Name`, whose interface is `Port`, declares no
 * recipient, or declares one and exports every handler, and every method of the port answers a
 * promise, which the runtime awaits after recording what it discloses; otherwise a message saying
 * what to add, which the generator's `.bounda/types.ts` fails to compile on.
 */
export type NotifiesRecipient<Name extends string, Module, Port> = Module extends {
  readonly recipient: unknown;
}
  ? [MissingHandler<Module>] extends [never]
    ? [SyncMethods<Port>] extends [never]
      ? true
      : `Port ${Name} declares a recipient, so ${SyncMethods<Port> extends "itself" ? "it" : `its method ${Extract<SyncMethods<Port>, string>}`} must return a promise`
    : `Port ${Name} declares a recipient, so it exports ${MissingHandler<Module>}, which tells it of ${(typeof RECIPIENT_HANDLERS)[MissingHandler<Module>]}`
  : true;

/**
 * One recipient a person's data went to, or may go to, as the export and `recipientsOf` list it:
 * article 15(1)(c) and the last sentence of article 19.
 */
export interface PersonRecipient {
  /**
   * The port, by `"<aggregate or read model>.<port>"`.
   */
  readonly port: string;
  readonly name: string;
  readonly kind: RecipientKind;
  readonly country: CountryCode;
  /**
   * The transfer when the country is outside the European Economic Area; `null` inside it.
   */
  readonly transfer: RecipientTransfer | null;
  /**
   * `disclosed` when a run handed the port data of the person, `presumed` when it cannot be ruled
   * out, as for a recipient declared after the data already existed, and `declared` when the port
   * may receive data of a category the person has and none was disclosed yet.
   */
  readonly status: "disclosed" | "presumed" | "declared";
  /**
   * Each category concerned, with its basis, `null` for the default category.
   */
  readonly categories: readonly {
    readonly name: PersonalCategoryName;
    readonly basis: LegalBasis | null;
  }[];
  /**
   * When the first and the last disclosure were recorded, as ISO timestamps; `null` unless
   * `disclosed`.
   */
  readonly firstDisclosedAt: string | null;
  readonly lastDisclosedAt: string | null;
  /**
   * `false` for a recipient whose port the app no longer declares, kept since data went to it.
   */
  readonly declared: boolean;
}
