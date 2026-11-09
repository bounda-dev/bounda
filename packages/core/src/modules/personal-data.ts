import type { DEFAULT_PERSONAL_CATEGORY } from "../adapter/storage/personal-key-store.ts";
import type { DurationInput } from "../contracts/duration.ts";
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
 * `forget(person, { categories })` does, with `reason: "retention"`. A duration string or
 * milliseconds, as the configuration's durations.
 */
export interface PersonalDataCategory {
  readonly basis: LegalBasis;
  readonly retention: DurationInput;
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
