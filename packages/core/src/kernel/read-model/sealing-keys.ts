import type { StoredEvent } from "../../contracts/event.ts";
import { createDisposableKey, type PersonalKey } from "../personal-data/crypto.ts";
import { openedUnder } from "../personal-data/event-store.ts";
import type { CategoryKey, PersonalKeys } from "../personal-data/wrapped-keys.ts";

// The keys a read model's values are sealed and opened with. A key no store holds any more, or
// never held, is `null` to open with; to seal with, it is a disposable key, so what is written for
// a person without a key is never read.
export interface SealingKeys {
  // The key a value of the person in the category is written under while `event` is projected:
  // the one the event was opened under, so a value read from an event of a key a forgetting kept
  // stays under it; else the one in force; else the latest a forgetting kept. A row that names no
  // person is written under a disposable key.
  forWrite(
    person: string | null,
    category: string,
    event: StoredEvent | null,
  ): Promise<PersonalKey>;
  forOpen(person: string, fingerprint: string): Promise<PersonalKey | null>;
  // Whether the person holds a key of the category a forgetting kept.
  kept(person: string, category: string): Promise<boolean>;
  // The category of the person's key of that fingerprint, `null` once it is gone.
  categoryOf(person: string, fingerprint: string): Promise<string | null>;
}

// Thrown by a ring of keys asked for a person it has not fetched: the read model's transaction is
// undone, the keys are fetched outside it, and the work runs again. A key is never read inside a
// read model's transaction, which on a database with a single writer would wait on itself.
export class KeysMissingError extends Error {
  readonly persons: readonly string[];
  constructor(persons: readonly string[]) {
    super("Keys of persons a read model writes or reads were not fetched yet");
    this.name = "KeysMissingError";
    this.persons = persons;
  }
}

// The newest a forgetting kept comes last.
const byRetainedSince = (a: CategoryKey, b: CategoryKey): number =>
  (a.retainedSince ?? "") < (b.retainedSince ?? "") ? -1 : 1;

const chosen = (
  held: readonly CategoryKey[],
  person: string,
  category: string,
  event: StoredEvent | null,
): PersonalKey | null => {
  const ofCategory = held.filter((key) => key.category === category);
  const fingerprints = new Set(
    event === null
      ? []
      : openedUnder(event)
          .filter((opened) => opened.person === person)
          .map(({ fingerprint }) => fingerprint),
  );
  return (
    ofCategory.find(({ key }) => fingerprints.has(key.fingerprint))?.key ??
    ofCategory.find(({ retainedSince }) => retainedSince === null)?.key ??
    [...ofCategory]
      .filter(({ retainedSince }) => retainedSince !== null)
      .sort(byRetainedSince)
      .at(-1)?.key ??
    null
  );
};

export interface SealingKeyRing extends SealingKeys {
  // Fetches every key of these persons the ring does not hold yet.
  fetch(persons: Iterable<string>): Promise<void>;
}

export interface CreateSealingKeyRingArgs {
  readonly keys: Pick<PersonalKeys, "heldAllOf">;
  // Fetches what it lacks on its own instead of throwing `KeysMissingError`: for reads outside any
  // transaction.
  readonly fetching: boolean;
}

export interface CreateSealingKeyRingFunction {
  (args: CreateSealingKeyRingArgs): SealingKeyRing;
}

// The keys of the persons fetched, for one batch or one query: a key forgotten meanwhile is still
// held until the next, as an event loaded before the forgetting still opens.
export const createSealingKeyRing: CreateSealingKeyRingFunction = ({ keys, fetching }) => {
  const held = new Map<string, readonly CategoryKey[]>();
  let disposable: Promise<PersonalKey> | null = null;
  const fetch = async (persons: Iterable<string>): Promise<void> => {
    const missing = [...new Set(persons)].filter((person) => !held.has(person));
    if (missing.length === 0) return;
    const fetched = await keys.heldAllOf(missing);
    for (const person of missing) held.set(person, fetched.get(person) ?? []);
  };
  const of = async (person: string): Promise<readonly CategoryKey[]> => {
    const known = held.get(person);
    if (known !== undefined) return known;
    if (!fetching) throw new KeysMissingError([person]);
    await fetch([person]);
    return held.get(person) ?? [];
  };
  return {
    fetch,
    forWrite: async (person, category, event) => {
      const key = person === null ? null : chosen(await of(person), person, category, event);
      if (key !== null) return key;
      disposable ??= createDisposableKey();
      return disposable;
    },
    forOpen: async (person, fingerprint) =>
      (await of(person)).find(({ key }) => key.fingerprint === fingerprint)?.key ?? null,
    kept: async (person, category) =>
      (await of(person)).some((held) => held.category === category && held.retainedSince !== null),
    categoryOf: async (person, fingerprint) =>
      (await of(person)).find(({ key }) => key.fingerprint === fingerprint)?.category ?? null,
  };
};
