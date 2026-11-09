import type { Hold } from "./hold.ts";

/**
 * The category of a field marked `personal` without one: what every personal field was before
 * categories existed, and what a store fills in for a key or an envelope that names none.
 */
export const DEFAULT_PERSONAL_CATEGORY: "default" = "default";

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
 * One of a person's keys, as `list` hands it out: the category it seals, the key, when it was
 * kept past a forgetting under a legal obligation (`null` while it is in force), and the last
 * activity of the person recorded on it (`null` before any), which a key kept past a forgetting
 * stops following.
 */
export interface HeldPersonalKey {
  readonly category: string;
  readonly key: StoredPersonalKey;
  readonly retainedSince: string | null;
  readonly lastActiveAt: string | null;
}

/**
 * A person, one of their keys and the category it seals, and the wait the rotation set after it
 * could not rewrap that key, `null` when none is set.
 */
export interface PersonalKeyRow {
  readonly person: string;
  readonly category: string;
  readonly key: StoredPersonalKey;
  readonly hold: Hold | null;
}

/**
 * A key a category's retention may destroy: the person, the key, and the wait the retention set
 * after it could not destroy it, `null` when none is set.
 */
export interface DueKey extends Omit<PersonalKeyRow, "key"> {
  readonly fingerprint: string;
  readonly lastActiveAt: string;
  readonly retainedSince: string | null;
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

export interface RetainKeyArgs {
  /**
   * When the forgetting kept it, as an ISO timestamp.
   */
  readonly since: string;
  /**
   * The person's last activity as the forgetting found it, which the key keeps from then on.
   */
  readonly lastActiveAt: string;
}

export interface ListDueArgs {
  readonly category: string;
  /**
   * Only the keys last active at or before it; every one when omitted.
   */
  readonly activeBefore?: Date;
  /**
   * Leaves out the keys held past it; holds are not looked at when omitted.
   */
  readonly releasedBy?: Date;
  readonly limit: number;
}

export interface NextDueHoldEndArgs {
  readonly category: string;
  /**
   * Only the holds that end after it.
   */
  readonly after: Date;
}

/**
 * A person whose personal data a state holds in the clear, with the fingerprint of the key it was
 * read under; `null` when it was read from events not sealed yet, staged by the same unit of work.
 * `retained` when that key was kept past a forgetting when it was read: such a read holds while
 * the key is kept, where one made while the key was in force holds only while it still is. A
 * person forgotten and given a new key since holds another fingerprint, so what the state holds
 * of them must not be written back.
 */
export interface KeyedPerson {
  readonly person: string;
  readonly fingerprint: string | null;
  readonly retained?: true;
}

/**
 * A personal value as it is stored: the ciphertext, its nonce, the person whose key opens it, the
 * category of that key, absent for the default one, and the fingerprint of the key, so a value
 * sealed under a key the person no longer has is told from one their current key opens.
 */
export interface PersonalEnvelope {
  readonly person: string;
  readonly category?: string;
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
  (
    row: { readonly persons?: readonly KeyedPerson[] },
    person: string,
    keep?: readonly string[],
  ): boolean;
}

/**
 * Whether the row names the person under a key outside `keep`, or read in the clear: what
 * `forget` removes, for a store that filters its rows itself.
 */
export const namesPerson: NamesPersonFunction = (row, person, keep = []) =>
  row.persons?.some(
    (held) =>
      held.person === person && (held.fingerprint === null || !keep.includes(held.fingerprint)),
  ) ?? false;

/**
 * The keys personal fields are encrypted with: one in force per person and category, and those
 * a forgetting kept past it under a legal obligation, `retained`. A key is named by the person
 * and its fingerprint.
 *
 * `get` is the key in force for the person and category, `null` when there is none. `find` is the
 * key of that fingerprint, in force or retained, `null` once it is gone. `list` is every key the
 * person holds. `add` stores `key` as the one in force for the person and category unless one is
 * in force already and resolves with the one in force, so two writers that find none keep the
 * same key. `remove` forgets a key and reports whether there was one; what was encrypted with it
 * can never be read again. `retain` keeps a key in force past a forgetting, and reports whether it
 * did: from then on it is no longer in force, and a later `add` for its category stores another.
 * `touch` records the person's last activity on every key of theirs in force, never moving one
 * back.
 *
 * `listDue` lists, least recently active first, the keys of a category, in force or retained,
 * whose person is not restricted, and `holdDue` sets the hold of one of them, which only the
 * retention reads, while it still records `lastActiveAt`. `nextDueHoldEnd` answers the earliest
 * end of such a hold past `after`, `null` when none is held past it.
 *
 * `listWrappedUnder` lists, by person, keys wrapped under one of `kids`, and `rewrap` replaces
 * the key `from` of a person with the same key wrapped as `to` says, keeping its fingerprint and
 * clearing its hold, only while the person still holds `from`, and reports whether it did: a key
 * forgotten or replaced meanwhile is never written back. `hold` sets the hold of the key `from` on
 * the same condition, and `nextHoldEnd` answers the earliest end of a hold past `after` among the
 * keys wrapped under one of `kids`, `null` when none is held past it.
 *
 * Stores that keep personal data in the clear, as snapshots do, compare a person's fingerprints
 * with the keys in force in the same statement as they write, so the store must keep them where
 * they can read them.
 */
export interface PersonalKeyStore {
  get(person: string, category: string): Promise<StoredPersonalKey | null>;
  find(person: string, fingerprint: string): Promise<HeldPersonalKey | null>;
  list(person: string): Promise<readonly HeldPersonalKey[]>;
  add(person: string, category: string, key: StoredPersonalKey): Promise<StoredPersonalKey>;
  remove(person: string, fingerprint: string): Promise<boolean>;
  retain(person: string, fingerprint: string, args: RetainKeyArgs): Promise<boolean>;
  touch(person: string, lastActiveAt: string): Promise<void>;
  listDue(args: ListDueArgs): Promise<readonly DueKey[]>;
  holdDue(person: string, fingerprint: string, lastActiveAt: string, hold: Hold): Promise<void>;
  nextDueHoldEnd(args: NextDueHoldEndArgs): Promise<Date | null>;
  listWrappedUnder(args: ListWrappedUnderArgs): Promise<readonly PersonalKeyRow[]>;
  rewrap(person: string, from: StoredPersonalKey, to: RewrappedKey): Promise<boolean>;
  hold(person: string, from: StoredPersonalKey, hold: Hold): Promise<void>;
  nextHoldEnd(args: NextKeyHoldEndArgs): Promise<Date | null>;
}
