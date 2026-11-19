import type { PersonStore } from "../../adapter/storage/person-store.ts";
import type { KeyedPerson } from "../../adapter/storage/personal-key-store.ts";
import { ProcessingRestrictedError } from "../../contracts/errors.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
import type { ReturnedRead } from "../ports/returns.ts";
import { covers, opensRequested } from "./refusal.ts";
import type { PersonalKeys } from "./wrapped-keys.ts";

export interface RefuseReturnedArgs {
  readonly persons: Pick<PersonStore, "restrictions">;
  readonly basis: RestrictionBasis | undefined;
  readonly reads: readonly ReturnedRead[];
}

export interface RefuseReturnedFunction {
  (args: RefuseReturnedArgs): Promise<readonly string[]>;
}

// Resolves to the restricted persons `basis` let through.
export const refuseReturned: RefuseReturnedFunction = async ({ persons, basis, reads }) => {
  const restricted = (
    await Promise.all(
      reads.map(async ({ person, categories }) => {
        const restrictions = await persons.restrictions(person);
        return categories.some((category) => covers(restrictions, category)) ? person : null;
      }),
    )
  ).filter((person) => person !== null);
  const [first] = restricted;
  if (first !== undefined && !opensRequested(basis)) throw new ProcessingRestrictedError(first);
  return [...new Set(restricted)];
};

export interface KeyedReturnedFunction {
  (
    keys: Pick<PersonalKeys, "heldAllOf" | "create">,
    reads: readonly ReturnedRead[],
  ): Promise<readonly KeyedPerson[]>;
}

// Under the key in force of each category, read for every person at once, and created when the
// person holds none, as for a field of theirs, so their forgetting reaches what is written from
// the read.
export const keyedReturned: KeyedReturnedFunction = async (keys, reads) => {
  const held = await keys.heldAllOf([...new Set(reads.map(({ person }) => person))]);
  return Promise.all(
    reads.flatMap(({ person, categories }) =>
      categories.map(async (category) => {
        const inForce = held
          .get(person)
          ?.find(
            (one) =>
              one.category === category &&
              one.retainedSince === null &&
              one.key.successor === undefined,
          )?.key;
        return {
          person,
          fingerprint: (inForce ?? (await keys.create(person, category))).fingerprint,
        };
      }),
    ),
  );
};

export interface ReadReturnedArgs {
  readonly persons: Pick<PersonStore, "restrictions">;
  readonly keys: Pick<PersonalKeys, "heldAllOf" | "create">;
  readonly basis: RestrictionBasis | undefined;
  readonly reads: readonly ReturnedRead[];
  // Takes the restricted persons `basis` let through, for the run's access record.
  readonly letThrough: Set<string>;
}

export interface ReadReturnedFunction {
  (args: ReadReturnedArgs): Promise<readonly KeyedPerson[]>;
}

// What a command, a policy or a process step does with what its ports returned.
export const readReturned: ReadReturnedFunction = async ({
  persons,
  keys,
  basis,
  reads,
  letThrough,
}) => {
  for (const one of await refuseReturned({ persons, basis, reads })) letThrough.add(one);
  return keyedReturned(keys, reads);
};
