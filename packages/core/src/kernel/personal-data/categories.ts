import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import { parseRetention, type Retention } from "../../contracts/duration.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import {
  LEGAL_BASES,
  type LegalBasis,
  type PersonalDataModule,
} from "../../modules/personal-data.ts";

/**
 * A category as the runtime uses it: its basis, `null` for the default category, which declares
 * none, and its retention, `null` when nothing forgets it for inactivity, as the default category
 * without `runtime.personalData.retention`.
 */
export interface PersonalCategory {
  readonly name: string;
  readonly basis: LegalBasis | null;
  readonly retention: Retention | null;
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
  of(name: string): PersonalCategory | undefined;
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
        `${at} must name its basis, one of ${LEGAL_BASES.map((basis) => `"${basis}"`).join(", ")}`,
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
    return { name, basis: category.basis, retention };
  });
};

/**
 * Throws `ConfigurationError` for a declaration the types would have refused, for a project that
 * skipped the type check.
 */
export const buildPersonalCategories: BuildPersonalCategoriesFunction = ({ module, retention }) => {
  const declared = declaredIn(module);
  const all: PersonalCategory[] = [
    { name: DEFAULT_PERSONAL_CATEGORY, basis: null, retention },
    ...declared,
  ];
  const byName = new Map(all.map((category) => [category.name, category]));
  return { all, declared, of: (name) => byName.get(name) };
};

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
