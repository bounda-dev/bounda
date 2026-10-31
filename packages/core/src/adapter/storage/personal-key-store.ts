/**
 * A person's key as the key store keeps it: the key, as opaque text the kernel chooses, and its
 * fingerprint, which names the key without revealing it.
 */
export interface StoredPersonalKey {
  readonly key: string;
  readonly fingerprint: string;
}

/**
 * A person whose personal data a state holds in the clear, with the fingerprint of the key it was
 * read under; `null` when it was read from events not sealed yet, staged by the same unit of work.
 * A person forgotten and given a new key since holds another fingerprint, so what the state holds
 * of them must not be written back.
 */
export interface KeyedPerson {
  readonly person: string;
  readonly fingerprint: string | null;
}

export interface KeyedPersonIdFunction {
  (held: KeyedPerson): string;
}

// Two entries for one person under two keys are two entries, never merged.
export const keyedPersonId: KeyedPersonIdFunction = ({ person, fingerprint }) =>
  JSON.stringify([person, fingerprint]);

/**
 * The keys the personal fields of events are encrypted with, one per person. `get` is `null` for
 * a person without one, as for one forgotten. `add` stores `key` for `person` unless one is in
 * force already and resolves with the one in force, so two writers that find none keep the same
 * key. `remove` forgets the key and reports whether there was one; what was encrypted with it can
 * never be read again.
 *
 * Stores that keep personal data in the clear, as snapshots do, compare a person's fingerprint
 * with the one in force in the same statement as they write, so the store must keep it where
 * they can read it.
 */
export interface PersonalKeyStore {
  get(person: string): Promise<StoredPersonalKey | null>;
  add(person: string, key: StoredPersonalKey): Promise<StoredPersonalKey>;
  remove(person: string): Promise<boolean>;
}
