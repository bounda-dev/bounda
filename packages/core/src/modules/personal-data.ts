import type { DEFAULT_PERSONAL_CATEGORY } from "../adapter/storage/personal-key-store.ts";
import type { DurationInput, RetentionInput } from "../contracts/duration.ts";
import type { AppPersonalCategory } from "../register/index.ts";

/**
 * The lawful basis of processing a category of personal data, as article 6(1) of the GDPR names
 * them. `legal-obligation` keeps a category past `forget` for its retention, restricted, since the
 * law that requires the data outweighs the request to erase it (article 17(3)(b)).
 */
export type LegalBasis =
  | "consent"
  | "contract"
  | "legal-obligation"
  | "vital-interests"
  | "public-task"
  | "legitimate-interests";

/**
 * Every lawful basis, in the order of article 6(1).
 */
export const LEGAL_BASES: readonly LegalBasis[] = [
  "consent",
  "contract",
  "legal-obligation",
  "vital-interests",
  "public-task",
  "legitimate-interests",
];

/**
 * Where data of a category comes from, as article 15(1)(g) asks the person be told of data not
 * collected from them: the person themselves (`"data-subject"`), what the app works out from other
 * data of theirs (`"derived"`), or a source by its name, a `third-party` or a `public` one.
 */
export type PersonalDataSource =
  | "data-subject"
  | "derived"
  | { readonly kind: "third-party" | "public"; readonly name: string };

/**
 * A special category of personal data, as article 9(1) of the GDPR lists them: data revealing
 * `racial-or-ethnic-origin`, `political-opinions`, `religious-or-philosophical-beliefs` or
 * `trade-union-membership`; `genetic` data; `biometric` data processed to identify a person
 * uniquely; data concerning `health`; and data concerning a person's
 * `sex-life-or-sexual-orientation`.
 */
export type SpecialCategoryKind =
  | "racial-or-ethnic-origin"
  | "political-opinions"
  | "religious-or-philosophical-beliefs"
  | "trade-union-membership"
  | "genetic"
  | "biometric"
  | "health"
  | "sex-life-or-sexual-orientation";

/**
 * Every special category, in the order of article 9(1).
 */
export const SPECIAL_CATEGORY_KINDS: readonly SpecialCategoryKind[] = [
  "racial-or-ethnic-origin",
  "political-opinions",
  "religious-or-philosophical-beliefs",
  "trade-union-membership",
  "genetic",
  "biometric",
  "health",
  "sex-life-or-sexual-orientation",
];

/**
 * The condition of article 9(2) that lifts the prohibition on processing special categories, by
 * its point: the person's `explicit-consent` (a); obligations and rights of
 * `employment-and-social-protection` law (b); the `vital-interests` of a person who cannot consent
 * (c); a `not-for-profit-body` with a political, philosophical, religious or trade-union aim, about
 * its members (d); data the person `made-public` manifestly (e); `legal-claims` and courts (f); a
 * `substantial-public-interest` under law (g); `health-or-social-care`, medicine and the assessment
 * of working capacity (h); `public-health` (i); and `archiving-research-or-statistics` under
 * article 89(1) (j). Explicit consent can be withdrawn, as consent can (article 7(3)), and makes
 * the data portable (article 20(1)(a)).
 */
export type SpecialCategoryCondition =
  | "explicit-consent"
  | "employment-and-social-protection"
  | "vital-interests"
  | "not-for-profit-body"
  | "made-public"
  | "legal-claims"
  | "substantial-public-interest"
  | "health-or-social-care"
  | "public-health"
  | "archiving-research-or-statistics";

/**
 * Every condition, in the order of article 9(2), from (a) to (j).
 */
export const SPECIAL_CATEGORY_CONDITIONS: readonly SpecialCategoryCondition[] = [
  "explicit-consent",
  "employment-and-social-protection",
  "vital-interests",
  "not-for-profit-body",
  "made-public",
  "legal-claims",
  "substantial-public-interest",
  "health-or-social-care",
  "public-health",
  "archiving-research-or-statistics",
];

/**
 * What a category declares when it holds special categories of data (article 9): which ones, at
 * least one, and the condition of article 9(2) it is processed on, besides its basis of article 6.
 */
export interface SpecialCategoryData {
  readonly kinds: readonly [SpecialCategoryKind, ...SpecialCategoryKind[]];
  readonly condition: SpecialCategoryCondition;
}

/**
 * What allows processing personal data relating to criminal convictions and offences or related
 * security measures, as article 10 names it: the control of an `official-authority`, or a `law`
 * of the Union or of a Member State that provides appropriate safeguards.
 */
export type CriminalDataAuthority = "official-authority" | "law";

/**
 * Every authority, in the order of article 10.
 */
export const CRIMINAL_DATA_AUTHORITIES: readonly CriminalDataAuthority[] = [
  "official-authority",
  "law",
];

/**
 * What a category declares when it holds data relating to criminal convictions and offences or
 * related security measures (article 10): the authority it is processed under, besides its basis
 * of article 6.
 */
export interface CriminalOffenceData {
  readonly authority: CriminalDataAuthority;
}

/**
 * A category of personal data as `app/personal-data.ts` declares it: on which basis it is
 * processed, and for how long after the person's last activity it is kept, after which the
 * runtime forgets it, as `forget(person, { categories })` does, with `reason: "retention"`: a
 * duration string or milliseconds, as the configuration's durations, or whole calendar months or
 * years, `"6y"`, which end on the same day of the month, or at the end of the month's last day
 * when it has no such day. `purposes` and `sources` are what the person's export tells them of it.
 * `special` and `criminal` say it holds data of article 9 or of article 10, and on which condition
 * or authority, which the export and the record of processing state too. A category on
 * `legal-obligation`, which outlives a forgetting, cannot rest its special data on
 * `explicit-consent`, which a withdrawal ends.
 */
export interface PersonalDataCategory {
  readonly basis: LegalBasis;
  readonly retention: RetentionInput;
  /**
   * Why it is processed, in words for the person: article 15(1)(a). At least one.
   */
  readonly purposes: readonly [string, ...string[]];
  /**
   * Where it comes from: article 15(1)(g). At least one.
   */
  readonly sources: readonly [PersonalDataSource, ...PersonalDataSource[]];
  readonly special?: SpecialCategoryData;
  readonly criminal?: CriminalOffenceData;
}

/**
 * What allows a decision based solely on automated processing, as article 22(2) names the
 * exceptions: it is needed for a `contract` with the person, authorised by `law`, or based on
 * their `explicit-consent`. On a contract or consent the person may ask for a human to step in
 * (article 22(3)), which the export tells them.
 */
export type AutomatedDecisionGround = "contract" | "law" | "explicit-consent";

/**
 * Every ground, in the order of article 22(2).
 */
export const AUTOMATED_DECISION_GROUNDS: readonly AutomatedDecisionGround[] = [
  "contract",
  "law",
  "explicit-consent",
];

/**
 * A decision the app makes about a person by automated means alone, with legal or similarly
 * significant effects for them, profiling included, as article 22(1) means it: on which
 * categories of their data, meaningful information about its `logic`, its `significance` and its
 * envisaged `consequences` for the person, as article 15(1)(h) asks them be told, whether it
 * profiles them, and its `ground`. A decision on a category that holds special categories of data
 * is allowed only when that category's condition is `explicit-consent` or
 * `substantial-public-interest`, and must say its `measures` (article 22(4)).
 */
export interface AutomatedDecision<Category extends string = PersonalCategoryName> {
  readonly categories: readonly [Category, ...Category[]];
  readonly logic: string;
  readonly significance: string;
  readonly consequences: string;
  readonly profiling: boolean;
  readonly ground: AutomatedDecisionGround;
  /**
   * The suitable measures that safeguard the person's rights, freedoms and legitimate interests,
   * in words for them: required on special categories of data (article 22(4)).
   */
  readonly measures?: string;
}

/**
 * What `app/personal-data.ts` exports as `automatedDecisions`: each decision by a name of the
 * app's, `{}` for an app that makes none.
 */
export type AutomatedDecisions<Category extends string = PersonalCategoryName> = Readonly<
  Record<string, AutomatedDecision<Category>>
>;

/**
 * What `app/personal-data.ts` exports as `categories`: each category by its name, which
 * `personal(schema, { category })` and `.personal({ category })` take. `default` is the category
 * of a field marked without one, and cannot be declared.
 */
export type PersonalDataCategories = Readonly<Record<string, PersonalDataCategory>>;

/**
 * `app/personal-data.ts`.
 */
export interface PersonalDataModule {
  readonly categories: PersonalDataCategories;
  readonly automatedDecisions: AutomatedDecisions<string>;
}

/**
 * A category of personal data `forget` takes and a forgetting names: one `app/personal-data.ts`
 * declares, or `"default"`, that of the fields marked without one.
 */
export type PersonalCategoryName = AppPersonalCategory | typeof DEFAULT_PERSONAL_CATEGORY;

/**
 * What `forget(personId, options)` takes besides the person.
 */
export interface ForgetOptions {
  /**
   * Forgets these categories of the person and nothing else, as when they withdraw a consent:
   * their keys go, the rest stays readable, and the person is not forgotten as a whole. Without
   * it, every category is. A category whose basis is `legal-obligation` is kept, restricted, until
   * its retention ends, either way.
   */
  readonly categories?: readonly PersonalCategoryName[];
}

type CategoriesOf<Module> = Module extends { readonly categories: infer Categories }
  ? Categories
  : never;

type DecisionsOf<Module> = Module extends { readonly automatedDecisions: infer Decisions }
  ? Decisions
  : never;

type DecidedOn<Decision> = Decision extends { readonly categories: readonly (infer Category)[] }
  ? Category
  : never;

// The categories the module's decisions name that it does not declare, `never` when none.
type UndeclaredIn<Module> = {
  [Name in keyof DecisionsOf<Module>]: Exclude<
    DecidedOn<DecisionsOf<Module>[Name]>,
    PersonalCategoriesOf<Module> | typeof DEFAULT_PERSONAL_CATEGORY
  >;
}[keyof DecisionsOf<Module>];

// The conditions of article 9(2) of the categories a decision names, `never` when none is special.
type ConditionsOf<Module, Category> = {
  [Name in Extract<Category, keyof CategoriesOf<Module>>]: CategoriesOf<Module>[Name] extends {
    readonly special: { readonly condition: infer Condition };
  }
    ? Condition
    : never;
}[Extract<Category, keyof CategoriesOf<Module>>];

// What article 22(4) allows a decision on special categories to rest on.
type DecidableCondition = "explicit-consent" | "substantial-public-interest";

export const DECIDABLE_CONDITIONS: readonly SpecialCategoryCondition[] = [
  "explicit-consent",
  "substantial-public-interest",
] satisfies readonly DecidableCondition[];

// The decisions on special categories whose condition article 22(4) does not allow.
type UnallowedIn<Module> = {
  [Name in keyof DecisionsOf<Module>]: [
    Exclude<ConditionsOf<Module, DecidedOn<DecisionsOf<Module>[Name]>>, DecidableCondition>,
  ] extends [never]
    ? never
    : Name;
}[keyof DecisionsOf<Module>];

// The decisions on special categories that do not say their measures.
type UnmeasuredIn<Module> = {
  [Name in keyof DecisionsOf<Module>]: [
    ConditionsOf<Module, DecidedOn<DecisionsOf<Module>[Name]>>,
  ] extends [never]
    ? never
    : DecisionsOf<Module>[Name] extends { readonly measures: string }
      ? never
      : Name;
}[keyof DecisionsOf<Module>];

// The categories kept past a forgetting whose special data rests on consent a withdrawal ends.
type KeptOnConsentIn<Module> = {
  [Name in keyof CategoriesOf<Module>]: CategoriesOf<Module>[Name] extends {
    readonly basis: "legal-obligation";
    readonly special: { readonly condition: "explicit-consent" };
  }
    ? Name
    : never;
}[keyof CategoriesOf<Module>];

/**
 * The names of the categories an `app/personal-data.ts` module declares, which the generator
 * registers so `personal({ category })` and `forget` take only those.
 */
export type PersonalCategoriesOf<Module> = Extract<keyof CategoriesOf<Module>, string>;

/**
 * `true` when an `app/personal-data.ts` module exports `categories` and `automatedDecisions` as
 * Bounda reads them, declares no category `default`, keeps no special data on `explicit-consent`
 * past a forgetting, and its decisions name only categories it declares or `"default"`, and decide
 * on special categories only as article 22(4) allows; otherwise a message saying what to change,
 * which the generator's `.bounda/types.ts` fails to compile on.
 */
export type DeclaresPersonalData<Module> = [CategoriesOf<Module>] extends [never]
  ? "app/personal-data.ts must export categories, each with its basis, retention, purposes and sources"
  : CategoriesOf<Module> extends PersonalDataCategories
    ? typeof DEFAULT_PERSONAL_CATEGORY extends PersonalCategoriesOf<Module>
      ? 'app/personal-data.ts declares "default", the category of fields marked without one; name it otherwise'
      : [KeptOnConsentIn<Module>] extends [never]
        ? [DecisionsOf<Module>] extends [never]
          ? "app/personal-data.ts must export automatedDecisions, {} when the app decides nothing about a person by automated means alone"
          : DecisionsOf<Module> extends AutomatedDecisions<string>
            ? [UndeclaredIn<Module>] extends [never]
              ? [UnallowedIn<Module>] extends [never]
                ? [UnmeasuredIn<Module>] extends [never]
                  ? true
                  : "app/personal-data.ts has an automated decision on special categories of data that does not say its measures (article 22(4))"
                : "app/personal-data.ts has an automated decision on special categories of data whose condition is neither explicit-consent nor substantial-public-interest (article 22(4))"
              : "app/personal-data.ts has an automated decision on a category it does not declare"
            : "app/personal-data.ts declares an automated decision without its categories, logic, significance, consequences, profiling or ground"
        : "app/personal-data.ts declares a category on legal-obligation whose special data rests on explicit-consent, which a withdrawal ends while the obligation keeps the data"
    : "app/personal-data.ts declares a category without a basis Bounda knows, a retention, a purpose or a source, or with special or criminal data without a condition or authority Bounda knows";

/**
 * Why a person's processing is restricted, as article 18(1) of the GDPR names the cases:
 * `accuracy-contested`, while the controller verifies data the person says is wrong (a);
 * `unlawful-processing`, processing that was unlawful and the person asked to keep rather than
 * erase (b); `legal-claims`, data the controller no longer needs and the person needs for a legal
 * claim (c); `objection-pending`, while an objection under article 21(1) is weighed (d).
 */
export type RestrictionGround =
  | "accuracy-contested"
  | "unlawful-processing"
  | "legal-claims"
  | "objection-pending";

/**
 * Every ground, in the order of article 18(1).
 */
export const RESTRICTION_GROUNDS: readonly RestrictionGround[] = [
  "accuracy-contested",
  "unlawful-processing",
  "legal-claims",
  "objection-pending",
];

/**
 * On what basis restricted data is processed anyway, as the exceptions of article 18(2) name
 * them: the person's `consent`, `legal-claims`, the `protection-of-rights` of another person, or an
 * important `public-interest`; any of them opens every restricted value. `legal-obligation` opens
 * only what a forgetting kept under a legal obligation, for that obligation (article 17(3)(b)), and
 * nothing a person asked to restrict.
 */
export type RestrictionBasis =
  | "consent"
  | "legal-claims"
  | "protection-of-rights"
  | "public-interest"
  | "legal-obligation";

/**
 * Every basis: those of article 18(2), then `legal-obligation`.
 */
export const RESTRICTION_BASES: readonly RestrictionBasis[] = [
  "consent",
  "legal-claims",
  "protection-of-rights",
  "public-interest",
  "legal-obligation",
];

/**
 * One restriction a person asked for and has not had lifted: its ground, the categories it covers,
 * `null` for every category and the person as a whole, and since when, as an ISO timestamp.
 */
export interface ProcessingRestriction {
  readonly ground: RestrictionGround;
  readonly categories: readonly PersonalCategoryName[] | null;
  readonly since: string;
}

/**
 * What `restrict(personId, options)` takes besides the person.
 */
export interface RestrictOptions {
  readonly ground: RestrictionGround;
  /**
   * Restricts these categories of the person alone, as when they contest the accuracy of one kind
   * of data. Without it, the person as a whole is restricted, every category included.
   */
  readonly categories?: readonly PersonalCategoryName[];
}

/**
 * How long before the lift the person is told, as `unrestrict` takes it: a duration, after which
 * the restriction is lifted, or `"given"`, when they were told already and it is lifted at once.
 */
export type RestrictionNotice = DurationInput | "given";

/**
 * What `unrestrict(personId, options)` takes besides the person.
 */
export interface UnrestrictOptions {
  /**
   * Article 18(3) asks that the person be told before their restriction is lifted. A duration
   * announces the lift with `ProcessingRestrictionLiftAnnounced`, which the app tells them from,
   * and lifts it that long after; `"given"` lifts it at once, for a person told already.
   */
  readonly notice: RestrictionNotice;
  /**
   * Lifts the restrictions on this ground alone; every ground when omitted.
   */
  readonly ground?: RestrictionGround;
  /**
   * Lifts these categories alone from restrictions of categories; every category when omitted. A
   * restriction of the person as a whole is lifted as a whole.
   */
  readonly categories?: readonly PersonalCategoryName[];
}
