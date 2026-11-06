import type { PersonStore } from "../../adapter/storage/person-store.ts";
import { ProcessingRestrictedError } from "../../contracts/errors.ts";

export interface RefuseRestrictedArgs {
  readonly persons: PersonStore;
  /**
   * Whom the work touches; `null` for work that touches nobody, which is never refused.
   */
  readonly person: string | null;
}

export interface RefuseRestrictedFunction {
  (args: RefuseRestrictedArgs): Promise<void>;
}

/**
 * Throws `ProcessingRestrictedError` when the person's processing is restricted.
 */
export const refuseRestricted: RefuseRestrictedFunction = async ({ persons, person }) => {
  if (person === null) return;
  const stored = await persons.get(person);
  if (stored !== null && stored.restrictedSince !== null) {
    throw new ProcessingRestrictedError(person);
  }
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
