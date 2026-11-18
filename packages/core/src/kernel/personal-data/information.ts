import type { StoredPerson } from "../../adapter/storage/person-store.ts";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type HeldPersonalKey,
} from "../../adapter/storage/personal-key-store.ts";
import { type Retention, retentionEnd } from "../../contracts/duration.ts";
import type { LegalBasis } from "../../modules/personal-data.ts";
import { formatRetention, type PersonalCategories, type PersonalCategory } from "./categories.ts";
import type {
  ExportedAutomatedDecision,
  ExportedCategory,
  ExportedRight,
  PersonalDataExport,
} from "./export.ts";

export interface PersonalDataInformationArgs {
  readonly categories: PersonalCategories;
  /**
   * The person's keys, in force and kept.
   */
  readonly keys: readonly HeldPersonalKey[];
  readonly person: StoredPerson | null;
}

export interface PersonalDataInformationFunction {
  (
    args: PersonalDataInformationArgs,
  ): Pick<PersonalDataExport, "categories" | "rights" | "automatedDecisions">;
}

const endOf = (at: string | null, retention: Retention | null): number | null =>
  at === null || retention === null ? null : retentionEnd(Date.parse(at), retention);

const instant = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

const earliest = (ends: readonly (number | null)[]): number | null => {
  const known = ends.filter((end): end is number => end !== null);
  return known.length === 0 ? null : Math.min(...known);
};

// The categories a right reaches: the declared ones it holds on.
const reaching = (
  categories: PersonalCategories,
  holds: (category: PersonalCategory) => boolean,
): string[] => categories.declared.filter(holds).map(({ name }) => name);

const onBases =
  (...bases: readonly LegalBasis[]) =>
  ({ basis }: PersonalCategory): boolean =>
    bases.includes(basis as LegalBasis);

// Consent, or special categories of data on explicit consent, which the GDPR treats alike for
// withdrawal (article 7(3)) and portability (article 20(1)(a)), whatever the basis.
const onConsent = (category: PersonalCategory): boolean =>
  category.basis === "consent" || category.special?.condition === "explicit-consent";

export const personalDataInformation: PersonalDataInformationFunction = ({
  categories,
  keys,
  person,
}) => {
  // The default category's retention forgets the person as a whole, from their last activity.
  const whole = endOf(person?.lastActiveAt ?? null, categories.default.retention);
  const exported: Record<string, ExportedCategory> = {};
  for (const { name, basis, purposes, sources, retention, special, criminal } of categories.all) {
    const theirs = keys.filter(({ category }) => category === name);
    const live = theirs.filter(({ retainedSince }) => retainedSince === null);
    const kept = theirs.flatMap(({ retainedSince, lastActiveAt }) => {
      const end = retainedSince === null ? null : endOf(lastActiveAt, retention);
      return end === null ? [] : [end];
    });
    const own = earliest(live.map(({ lastActiveAt }) => endOf(lastActiveAt, retention)));
    // A forgetting as a whole keeps what the law requires until its own retention ends.
    const until =
      name === DEFAULT_PERSONAL_CATEGORY
        ? whole
        : basis === "legal-obligation"
          ? own
          : earliest([own, whole]);
    exported[name] = {
      basis,
      special,
      criminal,
      purposes,
      sources,
      retention: retention === null ? null : formatRetention(retention),
      held: theirs.length > 0,
      keptUntil: live.length === 0 ? null : instant(until),
      restrictedUntil: instant(kept.length === 0 ? null : Math.max(...kept)),
    };
  }
  const held = new Set(keys.map(({ category }) => category));
  const automatedDecisions: ExportedAutomatedDecision[] = categories.decisions.filter((decision) =>
    decision.categories.some((category) => held.has(category)),
  );
  const intervention = [
    ...new Set(
      automatedDecisions
        .filter(({ ground }) => ground !== "law")
        .flatMap((decision) => decision.categories),
    ),
  ];
  const optional = (right: ExportedRight & { readonly categories: readonly string[] }) =>
    right.categories.length === 0 ? [] : [right];
  const rights: ExportedRight[] = [
    { right: "access", article: "15", categories: null },
    { right: "rectification", article: "16", categories: null },
    {
      right: "erasure",
      article: "17",
      categories: categories.all
        .filter(({ basis }) => basis !== "legal-obligation")
        .map(({ name }) => name),
    },
    { right: "restriction", article: "18", categories: null },
    ...optional({
      right: "portability",
      article: "20",
      categories: reaching(
        categories,
        (category) => onConsent(category) || onBases("contract")(category),
      ),
    }),
    {
      right: "objection",
      article: "21",
      categories: reaching(categories, onBases("public-task", "legitimate-interests")),
    },
    ...optional({
      right: "withdraw-consent",
      article: "7(3)",
      categories: reaching(categories, onConsent),
    }),
    ...optional({ right: "human-intervention", article: "22(3)", categories: intervention }),
    { right: "complaint", article: "77", categories: null },
  ];
  return { categories: exported, rights, automatedDecisions };
};
