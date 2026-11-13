import type { PersonStore } from "../../adapter/storage/person-store.ts";
import type { RestrictionView } from "../../adapter/storage/restricted-persons.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { RESTRICTION_BASES, type RestrictionBasis } from "../../modules/personal-data.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { isSealed } from "./crypto.ts";

/**
 * What a call that reads personal data takes to read restricted data too: the basis it reads it
 * on, as a query's `includeRestricted` names it.
 */
export interface IncludeRestrictedOptions {
  /**
   * Opens what a restriction leaves sealed, on a basis named explicitly, which the access log
   * records with those persons: a basis of article 18(2) opens all of it, `legal-obligation` only
   * what a forgetting kept.
   */
  readonly includeRestricted?: RestrictionBasis;
}

export interface RestrictionViewOfFunction {
  (includeRestricted: RestrictionBasis | undefined): RestrictionView;
}

/**
 * What a read leaves out for the basis it names: every restricted value without one, only what a
 * person asked to restrict on `legal-obligation`, nothing on a basis of article 18(2).
 */
export const restrictionViewOf: RestrictionViewOfFunction = (includeRestricted) => {
  if (includeRestricted === undefined) return "unrestricted";
  return includeRestricted === "legal-obligation" ? "retained" : "all";
};

export interface CheckIncludeRestrictedFunction {
  (subject: string, basis: unknown): RestrictionBasis | undefined;
}

/**
 * Throws `ValidationError` for a basis restricted data is never read on.
 */
export const checkIncludeRestricted: CheckIncludeRestrictedFunction = (subject, basis) => {
  if (basis === undefined || RESTRICTION_BASES.includes(basis as RestrictionBasis)) {
    return basis as RestrictionBasis | undefined;
  }
  throw new ValidationError(`${subject} names a basis restricted data is not read on`, [
    {
      path: ["includeRestricted"],
      message: `Expected one of ${RESTRICTION_BASES.map((name) => JSON.stringify(name)).join(", ")}`,
    },
  ]);
};

export interface RestrictedAmongFunction {
  (persons: Pick<PersonStore, "restrictions">): (person: string) => Promise<boolean>;
}

/**
 * Whether a person has any restriction they asked for, read once per person for the lookup's
 * life: what decides that a letter or a failure about them stays sealed.
 */
export const restrictedAmong: RestrictedAmongFunction = (persons) => {
  const read = new Map<string, Promise<boolean>>();
  return (person) => {
    const known = read.get(person);
    if (known !== undefined) return known;
    const restricted = persons.restrictions(person).then((rows) => rows.length > 0);
    read.set(person, restricted);
    return restricted;
  };
};

export interface SealedLeftFunction {
  (payload: unknown): unknown;
}

/**
 * The payload with each sealed field as `null`, opened nowhere: what a restricted letter shows.
 */
export const sealedLeft: SealedLeftFunction = (payload) =>
  isRecord(payload)
    ? Object.fromEntries(
        Object.entries(payload).map(([field, value]) => [field, isSealed(value) ? null : value]),
      )
    : payload;
