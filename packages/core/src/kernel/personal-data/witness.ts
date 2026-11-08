import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import type { StoredPersonalKey } from "../../adapter/storage/personal-key-store.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

/**
 * What `createTestApp` is told of while the app runs, so that `expectForgotten` can open what was
 * sealed under a key the app has since destroyed, and read the forget ledger the app opened.
 */
export interface PersonalDataWitness {
  onPersonalKey(person: string, key: StoredPersonalKey): void;
  onForgetLedger(ledger: ForgetLedger): void;
}

export interface WitnessedWrappingFunction {
  (wrapping: PersonalKeyWrapping, witness: PersonalDataWitness): PersonalKeyWrapping;
}

/**
 * `wrapping`, telling `witness` of every key it hands out unwrapped.
 */
export const witnessedWrapping: WitnessedWrappingFunction = (wrapping, witness) => {
  const seen = (person: string, key: StoredPersonalKey | null): StoredPersonalKey | null => {
    if (key !== null) witness.onPersonalKey(person, key);
    return key;
  };
  return {
    ...wrapping,
    unwrapped: async (stored, person) =>
      seen(person, await wrapping.unwrapped(stored, person)) as StoredPersonalKey,
    over: (keys) => {
      const over = wrapping.over(keys);
      return {
        ...over,
        get: async (person) => seen(person, await over.get(person)),
        add: async (person, key) => seen(person, await over.add(person, key)) as StoredPersonalKey,
      };
    },
  };
};
