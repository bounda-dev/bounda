import type { CheckpointStore } from "../adapter/ports/checkpoint-store.ts";

export interface MemoryLocks {
  /**
   * Takes the lock named `name` and resolves to what releases it; with `wait` false, resolves to
   * `undefined` at once when someone holds it.
   */
  acquire(name: string, wait: boolean): Promise<(() => void) | undefined>;
}

export interface CreateMemoryLocksFunction {
  (): MemoryLocks;
}

/**
 * Named locks held in memory, granted in the order they were asked for.
 */
export const createMemoryLocks: CreateMemoryLocksFunction = () => {
  const tails = new Map<string, Promise<void>>();
  return {
    acquire: async (name, wait) => {
      const held = tails.get(name);
      if (held !== undefined && !wait) return undefined;
      let release = (): void => {};
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = (held ?? Promise.resolve()).then(() => mine);
      tails.set(name, tail);
      await held;
      return () => {
        if (tails.get(name) === tail) tails.delete(name);
        release();
      };
    },
  };
};

export interface CheckpointJournal {
  readonly store: CheckpointStore;
  /**
   * Puts back, newest first, every checkpoint `store` changed, as long as nobody changed it again
   * since.
   */
  undo(): Promise<void>;
}

interface CheckpointChange {
  readonly subscriber: string;
  readonly before: number;
  readonly after: number;
}

export interface CreateCheckpointJournalFunction {
  (base: CheckpointStore): CheckpointJournal;
}

/**
 * A checkpoint store that writes through to `base` at once, as a row a database transaction
 * updates, and remembers each change so that a rolled back transaction can undo it.
 */
export const createCheckpointJournal: CreateCheckpointJournalFunction = (base) => {
  const changes: CheckpointChange[] = [];
  const changed = async (subscriber: string, before: number): Promise<void> => {
    changes.push({ subscriber, before, after: await base.get(subscriber) });
  };
  return {
    store: {
      get: (subscriber) => base.get(subscriber),
      list: () => base.list(),
      set: async (subscriber, position) => {
        const before = await base.get(subscriber);
        await base.set(subscriber, position);
        await changed(subscriber, before);
      },
      compareAndSet: async (subscriber, expected, position) => {
        const swapped = await base.compareAndSet(subscriber, expected, position);
        if (swapped) await changed(subscriber, expected);
        return swapped;
      },
      remove: async (subscriber) => {
        const before = await base.get(subscriber);
        await base.remove(subscriber);
        await changed(subscriber, before);
      },
    },
    undo: async () => {
      for (const { subscriber, before, after } of changes.splice(0).reverse()) {
        await base.compareAndSet(subscriber, after, before);
      }
    },
  };
};
