import type { PersonStore, StoredRestriction } from "../../adapter/storage/person-store.ts";
import type { KeyedPerson, PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import { ProcessingRestrictedError } from "../../contracts/errors.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";

/**
 * Whether `basis` lets through what a person asked to restrict: only the exceptions of article
 * 18(2) do, never `legal-obligation`, which opens only what a forgetting kept.
 */
export const opensRequested = (basis: RestrictionBasis | undefined): boolean =>
  basis !== undefined && basis !== "legal-obligation";

export interface RefuseRestrictedArgs {
  readonly persons: Pick<PersonStore, "restrictions">;
  /**
   * Whom the work touches; `null` for work that touches nobody, which is never refused.
   */
  readonly person: string | null;
  readonly basis?: RestrictionBasis | undefined;
}

export interface RefuseRestrictedFunction {
  (args: RefuseRestrictedArgs): Promise<void>;
}

/**
 * Throws `ProcessingRestrictedError` when the person is restricted as a whole, unless `basis` opens
 * it.
 */
export const refuseRestricted: RefuseRestrictedFunction = async ({ persons, person, basis }) => {
  if (person === null || opensRequested(basis)) return;
  const restrictions = await persons.restrictions(person);
  if (restrictions.some(({ category }) => category === null)) {
    throw new ProcessingRestrictedError(person);
  }
};

export interface RestrictedReadArgs {
  readonly persons: Pick<PersonStore, "restrictions">;
  readonly keys: Pick<PersonalKeyStore, "find">;
  /**
   * The persons whose data the work opened, each with the key it opened under.
   */
  readonly opened: readonly KeyedPerson[];
  /**
   * Whom the work touches besides, by id alone: restricted only as a whole.
   */
  readonly touches?: readonly string[];
}

export interface RestrictedReadFunction {
  (args: RestrictedReadArgs): Promise<RestrictedRead>;
}

/**
 * The restricted data some work would process: the persons a forgetting kept a key of, and those
 * whose restriction covers what it opened or who are restricted as a whole.
 */
export interface RestrictedRead {
  readonly retained: readonly string[];
  readonly requested: readonly string[];
}

const covers = (restrictions: readonly StoredRestriction[], category: string | null): boolean =>
  restrictions.some((row) => row.category === null || row.category === category);

/**
 * What of the work's reads is restricted, read outside any transaction: the store checks again
 * as the work's events are appended.
 */
export const restrictedRead: RestrictedReadFunction = async ({
  persons,
  keys,
  opened,
  touches = [],
}) => {
  const retained = new Set<string>();
  const requested = new Set<string>();
  const restrictionsOf = new Map<string, Promise<readonly StoredRestriction[]>>();
  const of = (person: string) => {
    const cached = restrictionsOf.get(person);
    if (cached !== undefined) return cached;
    const read = persons.restrictions(person);
    restrictionsOf.set(person, read);
    return read;
  };
  for (const person of touches) {
    if (covers(await of(person), null)) requested.add(person);
  }
  for (const { person, fingerprint, retained: keptKey } of opened) {
    if (fingerprint === null) continue;
    if (keptKey === true) retained.add(person);
    const restrictions = await of(person);
    if (restrictions.length === 0) continue;
    if (restrictions.some((row) => row.category === null)) {
      requested.add(person);
      continue;
    }
    const key = await keys.find(person, fingerprint);
    if (key !== null && covers(restrictions, key.category)) requested.add(person);
  }
  return { retained: [...retained], requested: [...requested] };
};

export interface RefuseRestrictedReadArgs extends RestrictedReadArgs {
  readonly basis?: RestrictionBasis | undefined;
}

export interface RefuseRestrictedReadFunction {
  (args: RefuseRestrictedReadArgs): Promise<readonly string[]>;
}

/**
 * Throws `ProcessingRestrictedError` for the first person whose restricted data the work would
 * process and `basis` does not open; resolves to the restricted persons `basis` let through, none
 * without one.
 */
export const refuseRestrictedRead: RefuseRestrictedReadFunction = async ({ basis, ...args }) => {
  const { retained, requested } = await restrictedRead(args);
  const refused = [
    ...(basis === undefined ? retained : []),
    ...(opensRequested(basis) ? [] : requested),
  ];
  const [first] = refused;
  if (first !== undefined) throw new ProcessingRestrictedError(first);
  return [...new Set([...retained, ...requested])];
};

export interface RestrictedPersonOfFunction {
  (error: unknown): string | null;
}

/**
 * The person a refusal names, so the letter of work that names nobody itself, such as a policy on
 * another aggregate's event, still names whom its command was refused for.
 */
export const restrictedPersonOf: RestrictedPersonOfFunction = (error) =>
  error instanceof ProcessingRestrictedError ? error.personId : null;
