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
 * A category of personal data as `app/personal-data.ts` declares it: why it is processed, and for
 * how long after the person's last activity it is kept, after which the runtime forgets it, as
 * `forget(person, { categories })` does, with `reason: "retention"`: a duration string or
 * milliseconds, as the configuration's durations, or whole calendar months or years, `"6y"`,
 * which end on the same day of the month, or at the end of the month's last day when it has no
 * such day.
 */
export interface PersonalDataCategory {
  readonly basis: LegalBasis;
  readonly retention: RetentionInput;
}

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

/**
 * The names of the categories an `app/personal-data.ts` module declares, which the generator
 * registers so `personal({ category })` and `forget` take only those.
 */
export type PersonalCategoriesOf<Module> = Extract<keyof CategoriesOf<Module>, string>;

/**
 * `true` when an `app/personal-data.ts` module exports `categories` as Bounda reads them, and
 * declares no category `default`; otherwise a message saying what to change, which the
 * generator's `.bounda/types.ts` fails to compile on.
 */
export type DeclaresPersonalData<Module> = [CategoriesOf<Module>] extends [never]
  ? "app/personal-data.ts must export categories, each with its basis and its retention"
  : CategoriesOf<Module> extends PersonalDataCategories
    ? typeof DEFAULT_PERSONAL_CATEGORY extends PersonalCategoriesOf<Module>
      ? 'app/personal-data.ts declares "default", the category of fields marked without one; name it otherwise'
      : true
    : "app/personal-data.ts declares a category without a basis Bounda knows or a retention";

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
