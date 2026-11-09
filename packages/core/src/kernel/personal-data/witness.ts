import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import type { PersonalKey } from "./crypto.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

/**
 * What `createTestApp` is told of while the app runs, so that `expectForgotten` can open what was
 * sealed under a key the app has since destroyed, and read the forget ledger the app opened.
 */
export interface PersonalDataWitness {
  onPersonalKey(person: string, key: PersonalKey): void;
  onForgetLedger(ledger: ForgetLedger): void;
}

export interface WitnessedWrappingFunction {
  (wrapping: PersonalKeyWrapping, witness: PersonalDataWitness): PersonalKeyWrapping;
}

// Every key the kernel seals or opens with comes out of `held`, `open` or `create`.
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
        held: async (person) => seen(person, await over.held(person)),
        open: async (person, stored) => seen(person, await over.open(person, stored)),
        create: async (person) => seen(person, await over.create(person)),
      };
    },
  };
};
