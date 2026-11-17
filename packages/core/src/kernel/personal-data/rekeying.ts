import type { KeyedPerson, SealedValue } from "../../adapter/storage/personal-key-store.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { categoryOf, isSealed, seal, unseal } from "./crypto.ts";
import type { PersonalKeys } from "./wrapped-keys.ts";

/**
 * What a reseal writes in place of what a store holds of persons, each call resolving to what it
 * was given, the same object, when nothing in it has to change.
 */
export interface Rekeying {
  /**
   * A value sealed under one key or under several, one inside the other: each layer under a key a
   * reseal superseded is sealed again under the key in its place, and a layer under a key no store
   * keeps, with what it holds, becomes `null` under a key no one keeps, as a forgetting leaves it,
   * so no copy of the key that sealed it opens it again.
   */
  sealed(value: SealedValue): Promise<SealedValue>;
  /**
   * The text of an error, sealed or in the clear.
   */
  text<Text extends string | SealedValue>(value: Text): Promise<Text>;
  /**
   * A payload or a state: its fields that hold a sealed value, those of its `state` that do, and
   * the sealed values of a field that holds a list of them.
   */
  payload<Value>(value: Value): Promise<Value>;
  /**
   * Whom a record names, each under the key in place of the one it was named under.
   */
  persons(persons: readonly KeyedPerson[]): Promise<readonly KeyedPerson[]>;
  /**
   * The persons and fingerprints of every key a value names, so they can be unwrapped ahead.
   */
  named(value: unknown): readonly (readonly [string, string])[];
}

export interface CreateRekeyingFunction {
  (keys: Pick<PersonalKeys, "opened" | "discarded">): Rekeying;
}

// The field of a lifecycle event's payload that holds the process's state.
const STATE = "state";

const sealedIn = (value: unknown): readonly SealedValue[] => {
  if (isSealed(value)) return [value];
  if (Array.isArray(value)) return value.filter(isSealed);
  return [];
};

/**
 * Rewrites what is sealed under persons' keys as a reseal leaves it: never what is sealed under a
 * key in force, which it opens only to look inside it.
 */
export const createRekeying: CreateRekeyingFunction = (keys) => {
  const forgotten = async (person: string, category: string): Promise<SealedValue> =>
    seal({ key: await keys.discarded(person), person, category, value: null });

  const sealed = async (value: SealedValue): Promise<SealedValue> => {
    const { person, key: fingerprint } = value.$personal;
    const category = categoryOf(value);
    const key = await keys.opened(person, fingerprint);
    if (key === null) return forgotten(person, category);
    const opened = await unseal({ key, sealed: value });
    const inside = isSealed(opened) ? await sealed(opened) : opened;
    if (key.successor === undefined && inside === opened) return value;
    const under = key.successor === undefined ? key : await keys.opened(person, key.successor);
    if (under === null) return forgotten(person, category);
    return seal({ key: under, person, category, value: inside });
  };

  const field = async (value: unknown): Promise<unknown> => {
    if (isSealed(value)) return sealed(value);
    if (!Array.isArray(value) || !value.some(isSealed)) return value;
    const each = await Promise.all(value.map((item) => (isSealed(item) ? sealed(item) : item)));
    return each.every((item, index) => item === value[index]) ? value : each;
  };

  const fields = async (
    record: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> => {
    let changed = false;
    const written: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record)) {
      const next: unknown =
        name === STATE && isRecord(value) ? await fields(value) : await field(value);
      written[name] = next;
      changed ||= next !== value;
    }
    return changed ? written : record;
  };

  const named = (value: unknown): readonly (readonly [string, string])[] => {
    if (!isRecord(value))
      return sealedIn(value).map(({ $personal }) => [$personal.person, $personal.key]);
    return Object.entries(value).flatMap(([name, inner]) =>
      name === STATE && isRecord(inner)
        ? named(inner)
        : sealedIn(inner).map(({ $personal }) => [$personal.person, $personal.key] as const),
    );
  };

  return {
    sealed,
    text: async (value) => (typeof value === "string" ? value : sealed(value)) as typeof value,
    payload: async (value) => (isRecord(value) ? ((await fields(value)) as typeof value) : value),
    persons: async (persons) => {
      let changed = false;
      const written = await Promise.all(
        persons.map(async (held) => {
          if (held.fingerprint === null) return held;
          const key = await keys.opened(held.person, held.fingerprint);
          if (key?.successor === undefined) return held;
          changed = true;
          return { ...held, fingerprint: key.successor };
        }),
      );
      return changed ? written : persons;
    },
    named,
  };
};
