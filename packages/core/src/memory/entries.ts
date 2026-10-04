import { ConfigurationError } from "../contracts/errors.ts";

export interface StoreEntries<Key> {
  read(key: Key): unknown;
  /**
   * Puts `before` back under `key`, `undefined` meaning no entry, unless the entry changed since
   * it became `after`.
   */
  putBack(key: Key, before: unknown, after: unknown): void;
}

export interface KeepEntriesFunction {
  <Store extends object, Key, Value>(
    store: Store,
    map: Map<string, Value>,
    keyOf: (key: Key) => string,
  ): Store;
}

export interface EntriesOfFunction {
  <Key>(store: object): StoreEntries<Key>;
}

// Kept off the stores' public types: only a memory transaction reaches a store's entries.
const kept = new WeakMap<object, unknown>();

/**
 * Lets `entriesOf(store)` read and put back the entries of `map`, which holds what `store` holds.
 */
export const keepEntries: KeepEntriesFunction = <Store extends object, Key, Value>(
  store: Store,
  map: Map<string, Value>,
  keyOf: (key: Key) => string,
): Store => {
  const entries: StoreEntries<Key> = {
    read: (key) => map.get(keyOf(key)),
    putBack: (key, before, after) => {
      const at = keyOf(key);
      if (map.get(at) !== after) return;
      if (before === undefined) map.delete(at);
      else map.set(at, before as Value);
    },
  };
  kept.set(store, entries);
  return store;
};

export const entriesOf: EntriesOfFunction = <Key>(store: object): StoreEntries<Key> => {
  const entries = kept.get(store);
  if (entries === undefined) {
    throw new ConfigurationError("A memory transaction needs the stores the memory adapter made");
  }
  return entries as StoreEntries<Key>;
};
