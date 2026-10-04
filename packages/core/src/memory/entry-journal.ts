export interface EntryWrite {
  /**
   * For a write whose transaction committed.
   */
  keep(): void;
  undo(): void;
}

/**
 * Called once the write has settled; returns what keeps or undoes what it changed.
 */
export type TrackedWrite = () => EntryWrite;

export interface EntryJournal<Key, Value> {
  /**
   * The store's entries. Every change made to it is recorded against the newest write still open
   * on that key, and against none when no write is open.
   */
  readonly map: Map<Key, Value>;
  /**
   * Opens a write to the entry under `key`; called right before it starts.
   */
  track(key: Key): TrackedWrite;
}

export interface CreateEntryJournalFunction {
  <Key, Value>(): EntryJournal<Key, Value>;
}

interface Layer<Key, Value> {
  readonly key: Key;
  before: Value | undefined;
  after: Value | undefined;
}

interface OpenWrite<Key, Value> {
  readonly key: Key;
  layer?: Layer<Key, Value>;
}

/**
 * A map that records each change against the write open on its entry, so a rolled back
 * transaction undoes its own writes and nothing else, even when a write awaits before changing the
 * map or another transaction writes the same entry meanwhile. Undoing a write that a later pending
 * write built on hands its `before` to that write; otherwise the undo leaves alone an entry
 * someone changed since.
 */
export const createEntryJournal: CreateEntryJournalFunction = <Key, Value>(): EntryJournal<
  Key,
  Value
> => {
  const map = new Map<Key, Value>();
  // Both oldest first, few at a time: only the writes of transactions not settled yet.
  const open: OpenWrite<Key, Value>[] = [];
  const pending: Layer<Key, Value>[] = [];
  const set = map.set.bind(map);
  const remove = map.delete.bind(map);

  const changing = (key: Key, after: Value | undefined): void => {
    const write = open.findLast((candidate) => candidate.key === key);
    if (write === undefined) return;
    if (write.layer === undefined) {
      write.layer = { key, before: map.get(key), after };
      pending.push(write.layer);
    } else {
      write.layer.after = after;
    }
  };

  map.set = (key, value) => {
    changing(key, value);
    return set(key, value);
  };
  map.delete = (key) => {
    changing(key, undefined);
    return remove(key);
  };

  return {
    map,
    track: (key) => {
      const write: OpenWrite<Key, Value> = { key };
      open.push(write);
      return () => {
        open.splice(open.indexOf(write), 1);
        const { layer } = write;
        if (layer === undefined) return { keep: () => {}, undo: () => {} };
        const settle = (): Layer<Key, Value> | undefined => {
          const index = pending.indexOf(layer);
          pending.splice(index, 1);
          return pending.slice(index).find((later) => later.key === key);
        };
        return {
          keep: () => {
            settle();
          },
          undo: () => {
            const next = settle();
            if (next !== undefined) {
              if (next.before === layer.after) next.before = layer.before;
              return;
            }
            if (map.get(key) !== layer.after) return;
            if (layer.before === undefined) remove(key);
            else set(key, layer.before);
          },
        };
      };
    },
  };
};
