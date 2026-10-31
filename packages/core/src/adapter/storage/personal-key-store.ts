/**
 * The keys the personal fields of events are encrypted with, one per person, as opaque text the
 * kernel chooses. `get` is `null` for a person without one, as for one forgotten. `add` stores
 * `key` for `person` unless one is in force already and resolves with the one in force, so two
 * writers that find none keep the same key. `remove` forgets the key and reports whether there
 * was one; what was encrypted with it can never be read again.
 */
export interface PersonalKeyStore {
  get(person: string): Promise<string | null>;
  add(person: string, key: string): Promise<string>;
  remove(person: string): Promise<boolean>;
}
