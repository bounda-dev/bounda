import type { AppWitness } from "../witness.ts";
import type { PersonalKey } from "./crypto.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

export interface WitnessedWrappingFunction {
  (wrapping: PersonalKeyWrapping, witness: Pick<AppWitness, "onPersonalKey">): PersonalKeyWrapping;
}

// Every key the kernel seals or opens with comes out of `held`, `opened`, `heldAll`, `heldAllOf`,
// `open` or `create`.
export const witnessedWrapping: WitnessedWrappingFunction = (wrapping, witness) => {
  const seen = <Key extends PersonalKey | null>(person: string, key: Key): Key => {
    if (key !== null) witness.onPersonalKey(person, key);
    return key;
  };
  return {
    ...wrapping,
    over: (keys) => {
      const over = wrapping.over(keys);
      return {
        ...over,
        held: async (person, category) => seen(person, await over.held(person, category)),
        opened: async (person, fingerprint) => seen(person, await over.opened(person, fingerprint)),
        heldAll: async (person) => {
          const all = await over.heldAll(person);
          for (const { key } of all) seen(person, key);
          return all;
        },
        heldAllOf: async (persons) => {
          const all = await over.heldAllOf(persons);
          for (const [person, held] of all) for (const { key } of held) seen(person, key);
          return all;
        },
        open: async (person, stored) => seen(person, await over.open(person, stored)),
        create: async (person, category) => seen(person, await over.create(person, category)),
      };
    },
  };
};
