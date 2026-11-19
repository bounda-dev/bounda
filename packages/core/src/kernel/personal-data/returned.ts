import type { PersonStore, StoredRestriction } from "../../adapter/storage/person-store.ts";
import type { KeyedPerson } from "../../adapter/storage/personal-key-store.ts";
import { ProcessingRestrictedError } from "../../contracts/errors.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
import type { ReturnedRead } from "../ports/returns.ts";
import { opensRequested } from "./refusal.ts";
import type { PersonalKeys } from "./wrapped-keys.ts";

export interface RefuseReturnedArgs {
  readonly persons: Pick<PersonStore, "restrictions">;
  readonly basis: RestrictionBasis | undefined;
  readonly reads: readonly ReturnedRead[];
}

export interface RefuseReturnedFunction {
  (args: RefuseReturnedArgs): Promise<readonly string[]>;
}

const covers = (restrictions: readonly StoredRestriction[], categories: readonly string[]) =>
  restrictions.some((row) => row.category === null || categories.includes(row.category));

// Resolves to the restricted persons `basis` let through.
export const refuseReturned: RefuseReturnedFunction = async ({ persons, basis, reads }) => {
  const restricted = (
    await Promise.all(
      reads.map(async ({ person, categories }) =>
        covers(await persons.restrictions(person), categories) ? person : null,
      ),
    )
  ).filter((person) => person !== null);
  const [first] = restricted;
  if (first !== undefined && !opensRequested(basis)) throw new ProcessingRestrictedError(first);
  return [...new Set(restricted)];
};

export interface KeyedReturnedFunction {
  (
    keys: Pick<PersonalKeys, "held" | "create">,
    reads: readonly ReturnedRead[],
  ): Promise<readonly KeyedPerson[]>;
}

// Created when the person holds none, as for a field of theirs, so their forgetting reaches what
// is written from the read.
export const keyedReturned: KeyedReturnedFunction = async (keys, reads) =>
  Promise.all(
    reads.flatMap(({ person, categories }) =>
      categories.map(async (category) => ({
        person,
        fingerprint: ((await keys.held(person, category)) ?? (await keys.create(person, category)))
          .fingerprint,
      })),
    ),
  );
