import type {
  PersonalDataForgottenEvent,
  PersonalDataRedactedEvent,
  ProcessingRestrictedEvent,
  ProcessingRestrictionLiftAnnouncedEvent,
  ProcessingRestrictionLiftedEvent,
} from "./bounda-events.ts";
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
 * The countries of the European Economic Area, by their ISO 3166-1 alpha-2 code: a transfer to one
 * of them needs no safeguard.
 */
export const EEA_COUNTRIES = [
  "AT",
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
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
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
 * A country by its ISO 3166-1 alpha-2 code.
 */
export type CountryCode = (typeof COUNTRY_CODES)[number];

/**
 * A country of the European Economic Area.
 */
export type EeaCountry = (typeof EEA_COUNTRIES)[number];

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
 * What a port module exports as `recipient` when the port sends personal data out: who receives
 * it, where, and which categories. A country outside the European Economic Area takes the
 * safeguard its transfer rests on; one inside takes none.
 */
export type RecipientDeclaration<Category extends string = PersonalCategoryName> =
  RecipientIdentity<Category> &
    (
      | { readonly country: EeaCountry; readonly safeguard?: never }
      | {
          readonly country: Exclude<CountryCode, EeaCountry>;
          readonly safeguard: TransferSafeguard;
        }
    );

/**
 * A recipient one of the runtime's events names, to be told of it: the port, by
 * `"<aggregate or read model>.<port>"`, and, of the categories it was disclosed, those the change
 * touches. `retained` are those a forgetting kept under a legal obligation instead, restricted;
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
 * kept under a legal obligation, to restrict rather than erase.
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
 * The handlers a recipient's port module exports, by the event each tells it of.
 */
export const RECIPIENT_HANDLERS = {
  onPersonalDataForgotten: "PersonalDataForgotten",
  onProcessingRestricted: "ProcessingRestricted",
  onProcessingRestrictionLiftAnnounced: "ProcessingRestrictionLiftAnnounced",
  onProcessingRestrictionLifted: "ProcessingRestrictionLifted",
  onPersonalDataRedacted: "PersonalDataRedacted",
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

type SyncMethods<Port> = {
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
      : `Port ${Name} declares a recipient, so its method ${Extract<SyncMethods<Port>, string>} must return a promise`
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
   * Whether the country is outside the European Economic Area, and on what safeguard the transfer
   * rests then; `null` inside it.
   */
  readonly transfer: { readonly safeguard: TransferSafeguard } | null;
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
