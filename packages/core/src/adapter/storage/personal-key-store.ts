import type { Hold } from "./hold.ts";

/**
 * A person's key as the key store keeps it: the key, as opaque text the kernel chooses; its
 * fingerprint, which names the key without revealing it and stays the same however the key is
 * wrapped; and the id of the key it is wrapped under, `null` for a key kept unwrapped.
 */
export interface StoredPersonalKey {
  readonly key: string;
  readonly fingerprint: string;
  readonly kid: string | null;
}

/**
 * A person, the key the store keeps for them, and the wait the rotation set after it could not
 * rewrap that key, `null` when none is set.
 */
export interface PersonalKeyRow {
  readonly person: string;
  readonly key: StoredPersonalKey;
  readonly hold: Hold | null;
}

/**
 * A key wrapped anew: its text and the id of the key it is now wrapped under.
 */
export type RewrappedKey = Pick<StoredPersonalKey, "key" | "kid">;

export interface ListWrappedUnderArgs {
  /**
   * The ids of the wrapping keys to list the keys of; `null` lists the keys kept unwrapped.
   */
  readonly kids: readonly (string | null)[];
  /**
   * Leaves out the keys held past it; holds are not looked at when omitted.
   */
  readonly releasedBy?: Date;
  readonly limit: number;
}

export interface NextKeyHoldEndArgs extends Pick<ListWrappedUnderArgs, "kids"> {
  /**
   * Only the holds that end after it.
   */
  readonly after: Date;
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

/**
 * A personal value as it is stored: the ciphertext, its nonce, the person whose key opens it and
 * the fingerprint of that key, so a value sealed under a key the person no longer has is told
 * from one their current key opens.
 */
export interface PersonalEnvelope {
  readonly person: string;
  readonly key: string;
  readonly iv: string;
  readonly data: string;
}

/**
 * A stored value that holds personal data: nothing but the envelope, under a key no schema field
 * takes. What an event's or a command's marked field holds in the store, and what a dead letter
 * holds for the text of an error.
 */
export interface SealedValue {
  readonly $personal: PersonalEnvelope;
}

export interface KeyedPersonIdFunction {
  (held: KeyedPerson): string;
}

// Two entries for one person under two keys are two entries, never merged.
export const keyedPersonId: KeyedPersonIdFunction = ({ person, fingerprint }) =>
  JSON.stringify([person, fingerprint]);

export interface NamesPersonFunction {
  (row: { readonly persons?: readonly KeyedPerson[] }, person: string): boolean;
}

// Under any key: what `forget` removes for a store that filters its rows itself.
export const namesPerson: NamesPersonFunction = (row, person) =>
  row.persons?.some((held) => held.person === person) ?? false;

/**
 * The keys the personal fields of events are encrypted with, one per person. `get` is `null` for
 * a person without one, as for one forgotten. `add` stores `key` for `person` unless one is in
 * force already and resolves with the one in force, so two writers that find none keep the same
 * key. `remove` forgets the key and reports whether there was one; what was encrypted with it can
 * never be read again. `listWrappedUnder` lists, by person, keys wrapped under one of `kids`, and
 * `rewrap` replaces the key `from` of a person with the same key wrapped as `to` says, keeping
 * its fingerprint and clearing its hold, only while the person still holds `from`, and reports
 * whether it did: a key forgotten or replaced meanwhile is never written back. `hold` sets the
 * hold of the key `from` on the same condition, and `nextHoldEnd` answers the earliest end of a
 * hold past `after` among the keys wrapped under one of `kids`, `null` when none is held past it.
 *
 * Stores that keep personal data in the clear, as snapshots do, compare a person's fingerprint
 * with the one in force in the same statement as they write, so the store must keep it where
 * they can read it.
 */
export interface PersonalKeyStore {
  get(person: string): Promise<StoredPersonalKey | null>;
  add(person: string, key: StoredPersonalKey): Promise<StoredPersonalKey>;
  remove(person: string): Promise<boolean>;
  listWrappedUnder(args: ListWrappedUnderArgs): Promise<readonly PersonalKeyRow[]>;
  rewrap(person: string, from: StoredPersonalKey, to: RewrappedKey): Promise<boolean>;
  hold(person: string, from: StoredPersonalKey, hold: Hold): Promise<void>;
  nextHoldEnd(args: NextKeyHoldEndArgs): Promise<Date | null>;
  /**
   * How many keys are wrapped under one of `kids`, whatever their holds.
   */
  countWrappedUnder(args: Pick<ListWrappedUnderArgs, "kids">): Promise<number>;
  /**
   * Clears every key's hold, and resolves to how many it cleared: what the runtime does once the
   * database went back to a copy, whose holds count failures the copy undid.
   */
  releaseHolds(): Promise<number>;
}
