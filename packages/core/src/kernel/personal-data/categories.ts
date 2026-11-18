import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import { describeNames } from "../../config/ports.ts";
import { parseRetention, type Retention } from "../../contracts/duration.ts";
import { ConfigurationError, ValidationError } from "../../contracts/errors.ts";
import {
  AUTOMATED_DECISION_GROUNDS,
  type AutomatedDecision,
  CRIMINAL_DATA_AUTHORITIES,
  type CriminalOffenceData,
  DECIDABLE_CONDITIONS,
  type DeclaredErasureExemption,
  ERASURE_EXEMPTIONS,
  type ErasureExemption,
  LEGAL_BASES,
  type LegalBasis,
  type PersonalDataModule,
  type PersonalDataSource,
  SPECIAL_CATEGORY_CONDITIONS,
  SPECIAL_CATEGORY_KINDS,
  SPECIFIC_PURPOSES,
  type SpecialCategoryCondition,
  type SpecialCategoryData,
  type SpecialCategoryKind,
  type SpecificPurpose,
} from "../../modules/personal-data.ts";
import { isRecord } from "../shared/merge-fields.ts";

/**
 * A category as the runtime uses it: its basis, `null` for the default category, which declares
 * none, and its retention, `null` when nothing forgets it for inactivity, as the default category
 * without `runtime.personalData.retention`.
 */
export interface PersonalCategory {
  readonly name: string;
  readonly basis: LegalBasis | null;
  readonly retention: Retention | null;
  /**
   * None for the default category, which declares none.
   */
  readonly purposes: readonly string[];
  readonly sources: readonly PersonalDataSource[];
  /**
   * `null` for a category without special categories of data (article 9), as the default one.
   */
  readonly special: SpecialCategoryData | null;
  /**
   * `null` for a category without data on criminal convictions and offences (article 10).
   */
  readonly criminal: CriminalOffenceData | null;
  /**
   * None for a category that declares none, as the default one.
   */
  readonly processedFor: readonly SpecificPurpose[];
  /**
   * The exemptions of article 17(3) that keep it past a forgetting, in the article's order; none
   * for the default category and any on `consent`.
   */
  readonly exemptions: readonly ErasureExemption[];
}

/**
 * An automated decision `app/personal-data.ts` declares, by its name.
 */
export interface DeclaredDecision extends AutomatedDecision<string> {
  readonly name: string;
}

/**
 * Every category of the app, the default one first, then those `app/personal-data.ts` declares in
 * the order it declares them.
 */
export interface PersonalCategories {
  readonly all: readonly PersonalCategory[];
  /**
   * The declared ones alone, whose retention a sweep of their keys applies.
   */
  readonly declared: readonly PersonalCategory[];
  /**
   * The category of fields marked without one, whose retention forgets the person as a whole.
   */
  readonly default: PersonalCategory;
  of(name: string): PersonalCategory | undefined;
  /**
   * The automated decisions `app/personal-data.ts` declares, in its order.
   */
  readonly decisions: readonly DeclaredDecision[];
}

export interface BuildPersonalCategoriesArgs {
  readonly module: PersonalDataModule | undefined;
  /**
   * `runtime.personalData.retention`, the default category's.
   */
  readonly retention: Retention | null;
}

export interface BuildPersonalCategoriesFunction {
  (args: BuildPersonalCategoriesArgs): PersonalCategories;
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isSource = (source: unknown): source is PersonalDataSource =>
  source === "data-subject" ||
  source === "derived" ||
  (isRecord(source) &&
    (source.kind === "third-party" || source.kind === "public") &&
    isText(source.name));

const listOf = <Item>(value: unknown, is: (item: unknown) => item is Item): Item[] | null =>
  Array.isArray(value) && value.length > 0 && value.every(is) ? [...value] : null;

const specialOf = (special: unknown, at: string): SpecialCategoryData | null => {
  if (special === undefined) return null;
  const kinds = isRecord(special)
    ? listOf(special.kinds, (kind): kind is SpecialCategoryKind =>
        SPECIAL_CATEGORY_KINDS.includes(kind as SpecialCategoryKind),
      )
    : null;
  if (!isRecord(special) || kinds === null) {
    throw new ConfigurationError(
      `${at} must name the special categories of data it holds, at least one of ${describeNames(SPECIAL_CATEGORY_KINDS)}`,
    );
  }
  const { condition } = special;
  if (!SPECIAL_CATEGORY_CONDITIONS.includes(condition as SpecialCategoryCondition)) {
    throw new ConfigurationError(
      `${at} must name the condition of article 9(2) it processes special categories of data on, one of ${describeNames(SPECIAL_CATEGORY_CONDITIONS)}`,
    );
  }
  return {
    kinds: kinds as [SpecialCategoryKind, ...SpecialCategoryKind[]],
    condition: condition as SpecialCategoryCondition,
  };
};

const criminalOf = (criminal: unknown, at: string): CriminalOffenceData | null => {
  if (criminal === undefined) return null;
  const authority = isRecord(criminal) ? criminal.authority : undefined;
  if (!CRIMINAL_DATA_AUTHORITIES.includes(authority as CriminalOffenceData["authority"])) {
    throw new ConfigurationError(
      `${at} must name the authority of article 10 it processes criminal data under, one of ${describeNames(CRIMINAL_DATA_AUTHORITIES)}`,
    );
  }
  return { authority: authority as CriminalOffenceData["authority"] };
};

const ARCHIVAL: readonly SpecificPurpose[] = SPECIFIC_PURPOSES.filter(
  (purpose) => purpose !== "direct-marketing",
);

const DECLARED_EXEMPTIONS: readonly DeclaredErasureExemption[] = [
  "public-health",
  "archiving-research-or-statistics",
];

const serves = (processedFor: readonly SpecificPurpose[], purposes: readonly SpecificPurpose[]) =>
  processedFor.some((purpose) => purposes.includes(purpose));

const processedForOf = (processedFor: unknown, at: string): SpecificPurpose[] => {
  if (processedFor === undefined) return [];
  const purposes = listOf(processedFor, (purpose): purpose is SpecificPurpose =>
    SPECIFIC_PURPOSES.includes(purpose as SpecificPurpose),
  );
  if (purposes === null) {
    throw new ConfigurationError(
      `${at} must name in processedFor at least one of ${describeNames(SPECIFIC_PURPOSES)}`,
    );
  }
  return purposes;
};

interface ExemptionArgs {
  readonly basis: LegalBasis;
  readonly special: SpecialCategoryData | null;
  readonly processedFor: readonly SpecificPurpose[];
  readonly declared: unknown;
  readonly at: string;
}

const declaredExemptionOf = ({
  basis,
  special,
  processedFor,
  declared,
  at,
}: ExemptionArgs): DeclaredErasureExemption | null => {
  if (declared === undefined) return null;
  if (!DECLARED_EXEMPTIONS.includes(declared as DeclaredErasureExemption)) {
    throw new ConfigurationError(
      `${at} must name as its erasureExemption one of ${describeNames(DECLARED_EXEMPTIONS)}`,
    );
  }
  if (basis === "consent") {
    throw new ConfigurationError(
      `${at} is on consent, which a withdrawal leaves without a basis to keep it on, and cannot claim an erasureExemption`,
    );
  }
  if (
    declared === "public-health" &&
    special?.condition !== "health-or-social-care" &&
    special?.condition !== "public-health"
  ) {
    throw new ConfigurationError(
      `${at} claims public-health (article 17(3)(c)), which needs special categories of data on health-or-social-care or public-health`,
    );
  }
  if (declared === "archiving-research-or-statistics" && !serves(processedFor, ARCHIVAL)) {
    throw new ConfigurationError(
      `${at} claims archiving-research-or-statistics (article 17(3)(d)), which needs one of ${describeNames(ARCHIVAL)} in processedFor`,
    );
  }
  return declared as DeclaredErasureExemption;
};

// What article 17(3) spares from erasure, as the declaration shows it: its basis (b), its
// condition of article 9(2) where it states the necessity itself (c, e), and what it claims (c,
// d). Nothing on consent, whose withdrawal leaves no basis to keep it on (article 17(1)(b)).
const exemptionsOf = (
  { basis, special }: Pick<ExemptionArgs, "basis" | "special">,
  declared: DeclaredErasureExemption | null,
): ErasureExemption[] => {
  if (basis === "consent") return [];
  const held = new Set<ErasureExemption>();
  if (basis === "legal-obligation" || basis === "public-task") held.add(basis);
  if (special?.condition === "public-health" || declared === "public-health") {
    held.add("public-health");
  }
  if (declared === "archiving-research-or-statistics") held.add(declared);
  if (special?.condition === "legal-claims") held.add("legal-claims");
  return ERASURE_EXEMPTIONS.filter((exemption) => held.has(exemption));
};

const declaredIn = (module: PersonalDataModule | undefined): PersonalCategory[] => {
  if (module === undefined) return [];
  const { categories } = module;
  if (typeof categories !== "object" || categories === null || Array.isArray(categories)) {
    throw new ConfigurationError("app/personal-data.ts must export categories as an object");
  }
  return Object.entries(categories).map(([name, category]) => {
    const at = `app/personal-data.ts: category "${name}"`;
    if (name === DEFAULT_PERSONAL_CATEGORY) {
      throw new ConfigurationError(
        `${at} is the category of fields marked without one, and cannot be declared`,
      );
    }
    if (!NAME.test(name)) {
      throw new ConfigurationError(
        `${at} must start with a letter and hold only letters, digits, "-" and "_"`,
      );
    }
    if (!LEGAL_BASES.includes(category?.basis)) {
      throw new ConfigurationError(
        `${at} must name its basis, one of ${describeNames(LEGAL_BASES)}`,
      );
    }
    let retention: Retention;
    try {
      retention = parseRetention(category.retention);
    } catch {
      throw new ConfigurationError(
        `${at} must give its retention as a duration, such as "30d", milliseconds, or whole months or years, such as "6y"`,
      );
    }
    if (retention.months === 0 && retention.ms <= 0) {
      throw new ConfigurationError(`${at} must keep its data for more than no time`);
    }
    const purposes = listOf(category.purposes, isText);
    if (purposes === null) {
      throw new ConfigurationError(
        `${at} must name its purposes, at least one, each in words for the person`,
      );
    }
    const sources = listOf(category.sources, isSource);
    if (sources === null) {
      throw new ConfigurationError(
        `${at} must name its sources, at least one: "data-subject", "derived", or { kind: "third-party" or "public", name }`,
      );
    }
    const special = specialOf(category.special, at);
    const criminal = criminalOf(category.criminal, at);
    const processedFor = processedForOf(category.processedFor, at);
    if (
      special?.condition === "archiving-research-or-statistics" &&
      !serves(processedFor, ARCHIVAL)
    ) {
      throw new ConfigurationError(
        `${at} holds special categories of data on archiving-research-or-statistics and must name the purpose of article 89(1) it serves in processedFor, one of ${describeNames(ARCHIVAL)}`,
      );
    }
    const { basis } = category;
    const declared = declaredExemptionOf({
      basis,
      special,
      processedFor,
      declared: category.erasureExemption,
      at,
    });
    const exemptions = exemptionsOf({ basis, special }, declared);
    if (exemptions.length > 0 && special?.condition === "explicit-consent") {
      throw new ConfigurationError(
        `${at} is kept past a forgetting (${exemptions.join(", ")}), and cannot rest its special categories of data on explicit-consent, which a withdrawal ends`,
      );
    }
    if (exemptions.length > 0 && processedFor.includes("direct-marketing")) {
      throw new ConfigurationError(
        `${at} is kept past a forgetting (${exemptions.join(", ")}), and cannot be processed for direct-marketing, which an objection stops at once (article 21(3))`,
      );
    }
    return {
      name,
      basis,
      retention,
      purposes,
      sources,
      special,
      criminal,
      processedFor,
      exemptions,
    };
  });
};

const decisionsIn = (
  module: PersonalDataModule | undefined,
  known: ReadonlyMap<string, PersonalCategory>,
): DeclaredDecision[] => {
  if (module === undefined) return [];
  const { automatedDecisions } = module;
  if (
    typeof automatedDecisions !== "object" ||
    automatedDecisions === null ||
    Array.isArray(automatedDecisions)
  ) {
    throw new ConfigurationError(
      "app/personal-data.ts must export automatedDecisions as an object, {} when the app decides nothing about a person by automated means alone",
    );
  }
  return Object.entries(automatedDecisions).map(([name, decision]) => {
    const at = `app/personal-data.ts: automated decision "${name}"`;
    const [first, ...rest] =
      listOf(decision?.categories, (category): category is string =>
        known.has(category as string),
      ) ?? [];
    if (first === undefined) {
      throw new ConfigurationError(
        `${at} must name the categories it decides on, at least one, each declared or "default"`,
      );
    }
    for (const field of ["logic", "significance", "consequences"] as const) {
      if (!isText(decision[field])) {
        throw new ConfigurationError(`${at} must give its ${field} in words for the person`);
      }
    }
    if (typeof decision.profiling !== "boolean") {
      throw new ConfigurationError(`${at} must say whether it profiles the person`);
    }
    if (!AUTOMATED_DECISION_GROUNDS.includes(decision.ground)) {
      throw new ConfigurationError(
        `${at} must name its ground, one of ${describeNames(AUTOMATED_DECISION_GROUNDS)}`,
      );
    }
    const { measures } = decision;
    if (measures !== undefined && !isText(measures)) {
      throw new ConfigurationError(`${at} must give its measures in words for the person`);
    }
    const categories: [string, ...string[]] = [first, ...rest];
    const special = [...known.values()].flatMap(({ name: category, special: data }) =>
      data === null || !categories.includes(category) ? [] : [{ category, ...data }],
    );
    const unallowed = special.find(({ condition }) => !DECIDABLE_CONDITIONS.includes(condition));
    if (unallowed !== undefined) {
      throw new ConfigurationError(
        `${at} decides on special categories of data of "${unallowed.category}", processed on "${unallowed.condition}"; article 22(4) allows it only on ${describeNames(DECIDABLE_CONDITIONS)}`,
      );
    }
    if (special.length > 0 && measures === undefined) {
      throw new ConfigurationError(
        `${at} decides on special categories of data and must give the measures that safeguard the person, in words for them (article 22(4))`,
      );
    }
    return {
      name,
      categories,
      logic: decision.logic,
      significance: decision.significance,
      consequences: decision.consequences,
      profiling: decision.profiling,
      ground: decision.ground,
      ...(measures === undefined ? {} : { measures }),
    };
  });
};

/**
 * Throws `ConfigurationError` for a declaration the types would have refused, for a project that
 * skipped the type check.
 */
export const buildPersonalCategories: BuildPersonalCategoriesFunction = ({ module, retention }) => {
  const declared = declaredIn(module);
  const fallback: PersonalCategory = {
    name: DEFAULT_PERSONAL_CATEGORY,
    basis: null,
    retention,
    purposes: [],
    sources: [],
    special: null,
    criminal: null,
    processedFor: [],
    exemptions: [],
  };
  const all = [fallback, ...declared];
  const byName = new Map(all.map((category) => [category.name, category]));
  return {
    all,
    declared,
    default: fallback,
    of: (name) => byName.get(name),
    decisions: decisionsIn(module, byName),
  };
};

export interface ObjectableFunction {
  (category: PersonalCategory): boolean;
}

// Research or statistics on any basis but `public-task`: article 21(6) spares only a task carried
// out for reasons of public interest.
export const researched: ObjectableFunction = (category) =>
  category.basis !== "public-task" &&
  serves(category.processedFor, ["scientific-or-historical-research", "statistics"]);

// Whether an objection of article 21 reaches the category: (1), (2) or (6).
export const objectable: ObjectableFunction = (category) =>
  category.basis === "public-task" ||
  category.basis === "legitimate-interests" ||
  category.processedFor.includes("direct-marketing") ||
  researched(category);

// Whether an objection under article 21(1) reaches the category and is weighed for it, which is
// what restricting it while the objection is weighed asks (article 18(1)(d)): on `public-task` or
// `legitimate-interests`, but not for direct marketing, which nothing weighs. The default category
// declares no basis to tell by, so it may be held.
export const pendsObjection: ObjectableFunction = (category) =>
  category.basis === null ||
  ((category.basis === "public-task" || category.basis === "legitimate-interests") &&
    !category.processedFor.includes("direct-marketing"));

export interface CheckCategoryArgs {
  readonly categories: PersonalCategories;
  readonly category: string;
  /**
   * Where the mark is, for the message: `event customer.CustomerRegistered, field "email"`.
   */
  readonly at: string;
}

export interface CheckCategoryFunction {
  (args: CheckCategoryArgs): void;
}

export const checkCategory: CheckCategoryFunction = ({ categories, category, at }) => {
  if (categories.of(category) !== undefined) return;
  throw new ConfigurationError(
    `${at} is marked personal in the category "${category}", which app/personal-data.ts does not declare`,
  );
};

/**
 * What checking the names of categories needs of the app's.
 */
export type CategoryNames = Pick<PersonalCategories, "of">;

export interface CheckCategoryNamesArgs {
  readonly categories: CategoryNames;
  readonly asked: unknown;
  /**
   * The call that names them, as its message says it.
   */
  readonly operation: string;
}

export interface CheckCategoryNamesFunction {
  (args: CheckCategoryNamesArgs): readonly string[];
}

/**
 * The categories a call names, each once. Throws `ValidationError` for none, or for a category the
 * app does not have.
 */
export const checkCategoryNames: CheckCategoryNamesFunction = ({
  categories,
  asked,
  operation,
}) => {
  if (!Array.isArray(asked) || asked.length === 0) {
    throw new ValidationError(`${operation} needs at least one category when it names them`, [
      { path: ["categories"], message: "Expected a non-empty array of categories" },
    ]);
  }
  const unknown = asked.filter(
    (category) => typeof category !== "string" || categories.of(category) === undefined,
  );
  if (unknown.length > 0) {
    throw new ValidationError(
      `${operation} names categories the app does not have: ${unknown.map((category) => JSON.stringify(category)).join(", ")}`,
      [
        {
          path: ["categories"],
          message: 'Expected categories app/personal-data.ts declares, or "default"',
        },
      ],
    );
  }
  return [...new Set(asked as string[])];
};

export interface FormatRetentionFunction {
  (retention: Retention): string;
}

const UNITS: readonly (readonly [string, number])[] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
];

/**
 * A retention as configuration writes it, in the largest unit that divides it.
 */
export const formatRetention: FormatRetentionFunction = ({ months, ms }) => {
  if (months > 0) return months % 12 === 0 ? `${months / 12}y` : `${months}mo`;
  for (const [unit, size] of UNITS) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
};

interface Marked {
  readonly personal: { readonly categories: Readonly<Record<string, string>> } | null;
}

export interface CheckMarkedCategoriesArgs {
  readonly categories: PersonalCategories;
  readonly aggregates: {
    readonly byName: Readonly<
      Record<
        string,
        {
          readonly eventsByType: Readonly<Record<string, Marked>>;
          readonly commands: Readonly<Record<string, Marked>>;
        }
      >
    >;
  };
  readonly processes: { readonly all: readonly ({ readonly name: string } & Marked)[] };
  readonly readModels: Readonly<
    Record<
      string,
      { readonly fields: Readonly<Record<string, { readonly category: string | null }>> }
    >
  >;
}

export interface CheckMarkedCategoriesFunction {
  (args: CheckMarkedCategoriesArgs): void;
}

/**
 * Throws `ConfigurationError` for a field marked personal in a category the app does not declare,
 * which the types refuse, for a project that skipped the type check.
 */
export const checkMarkedCategories: CheckMarkedCategoriesFunction = ({
  categories,
  aggregates,
  processes,
  readModels,
}) => {
  const check = (marked: Marked, at: string): void => {
    for (const [field, category] of Object.entries(marked.personal?.categories ?? {})) {
      checkCategory({ categories, category, at: `${at}, field "${field}"` });
    }
  };
  for (const [name, aggregate] of Object.entries(aggregates.byName)) {
    for (const [type, event] of Object.entries(aggregate.eventsByType)) {
      check(event, `Event ${name}.${type}`);
    }
    for (const [type, command] of Object.entries(aggregate.commands)) {
      check(command, `Command ${name}.${type}`);
    }
  }
  for (const process of processes.all) check(process, `State of process ${process.name}`);
  for (const [name, readModel] of Object.entries(readModels)) {
    for (const [field, { category }] of Object.entries(readModel.fields)) {
      if (category === null) continue;
      checkCategory({ categories, category, at: `Read model ${name}, field "${field}"` });
    }
  }
};
