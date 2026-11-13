import type { RewrappedKey, StoredPersonalKey } from "./personal-key-store.ts";

/**
 * The one key a database computes the blind indexes of its read models with, kept wrapped as the
 * keys of persons are. It names no person: forgetting one leaves it, and the indexes of their
 * values are emptied instead.
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
   * Replaces how the key is wrapped, `false` when it is no longer `from`.
   */
  rewrap(from: StoredPersonalKey, to: RewrappedKey): Promise<boolean>;
}
