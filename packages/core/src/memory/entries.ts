export interface StoreEntries<Key> {
  read(key: Key): unknown;
  /**
   * Puts `before` back under `key`, `undefined` meaning no entry, unless the entry changed since
   * it became `after`.
   */
  putBack(key: Key, before: unknown, after: unknown): void;
}

/**
 * A store with what reaches its entries, which only a memory transaction is given.
 */
export interface WithEntries<Store, Key> {
  readonly store: Store;
  readonly entries: StoreEntries<Key>;
}

export interface CreateStoreEntriesFunction {
  <Key, Value>(map: Map<string, Value>, keyOf: (key: Key) => string): StoreEntries<Key>;
}

export const createStoreEntries: CreateStoreEntriesFunction = <Key, Value>(
  map: Map<string, Value>,
  keyOf: (key: Key) => string,
): StoreEntries<Key> => ({
  read: (key) => map.get(keyOf(key)),
  putBack: (key, before, after) => {
    const at = keyOf(key);
    if (map.get(at) !== after) return;
    if (before === undefined) map.delete(at);
    else map.set(at, before as Value);
  },
});
