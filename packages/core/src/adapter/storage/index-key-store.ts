import type { RewrappedKey, StoredPersonalKey } from "./personal-key-store.ts";

/**
 * The one key a database computes the blind indexes of its read models with, kept wrapped as the
 * keys of persons are. It names no person: forgetting one leaves it, and the indexes of their
 * values are emptied instead. A reseal puts another in its place and keeps it as the previous key,
 * which still opens and finds what is under it, until it drops it.
 */
export interface IndexKeyStore {
  /**
   * The key, `null` before one is added.
   */
  get(): Promise<StoredPersonalKey | null>;
  /**
   * Stores `key` unless the database holds one already, and resolves the one it holds: of two
   * instances adding one at once, both end with the same.
   */
  add(key: StoredPersonalKey, at: Date): Promise<StoredPersonalKey>;
  /**
   * The previous key, `null` while there is none.
   */
  previous(): Promise<StoredPersonalKey | null>;
  /**
   * Replaces how the key `from`, in force or previous, is wrapped, `false` when the database no
   * longer holds `from`.
   */
  rewrap(from: StoredPersonalKey, to: RewrappedKey): Promise<boolean>;
  /**
   * Puts `to` in force in the place of `from`, which becomes the previous key, wrapped as `kept`
   * says, `false` when `from` is no longer in force or another previous key is still held. One
   * that stopped halfway is finished by the next.
   */
  supersede(
    from: StoredPersonalKey,
    to: StoredPersonalKey,
    kept: RewrappedKey,
    at: Date,
  ): Promise<boolean>;
  /**
   * Destroys the previous key, `false` when it is no longer `previous`.
   */
  dropPrevious(previous: StoredPersonalKey): Promise<boolean>;
  /**
   * Puts `to` in the place of `from`, another key, `false` when the database no longer holds
   * `from`: of two instances replacing it at once, one wins and the other reads again.
   */
  replace(from: StoredPersonalKey, to: StoredPersonalKey): Promise<boolean>;
  /**
   * Removes the key and the previous one: what forgetting the tenant does, once its own key is
   * gone.
   */
  clear(): Promise<void>;
}
