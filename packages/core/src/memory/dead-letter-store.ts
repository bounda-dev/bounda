import type {
  DeadLetter,
  DeadLetterStore,
  ListDeadLettersArgs,
} from "../adapter/ports/dead-letter-store.ts";
import { DeadLetterSettledError } from "../contracts/errors.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";

export interface CreateMemoryDeadLetterStoreFunction {
  (): DeadLetterStore;
}

export interface CreateKeptDeadLetterStoreFunction {
  (): WithEntries<DeadLetterStore, string>;
}

const matches = (letter: DeadLetter, args: ListDeadLettersArgs): boolean =>
  (args.kind === undefined || letter.kind === args.kind) &&
  (args.handler === undefined || letter.handler === args.handler) &&
  (args.status === undefined || letter.status === args.status);

export const createKeptDeadLetterStore: CreateKeptDeadLetterStoreFunction = () => {
  const letters = new Map<string, DeadLetter>();

  const select = (args: ListDeadLettersArgs): DeadLetter[] =>
    [...letters.values()].filter((letter) => matches(letter, args));

  const store: DeadLetterStore = {
    add: async (letter) => {
      const existing = letters.get(letter.id);
      if (existing !== undefined) return existing;
      const stored: DeadLetter = { ...letter, status: "failed" };
      letters.set(letter.id, stored);
      return stored;
    },
    get: async (id) => letters.get(id) ?? null,
    list: async (args = {}) => {
      const offset = args.offset ?? 0;
      const selected = select(args);
      return selected.slice(offset, args.limit === undefined ? undefined : offset + args.limit);
    },
    count: async (args = {}) => select(args).length,
    updateStatus: async (id, status) => {
      const existing = letters.get(id);
      if (existing?.status !== "failed") throw new DeadLetterSettledError({ id });
      letters.set(id, { ...existing, status });
    },
    remove: async (id) => {
      letters.delete(id);
    },
  };
  return { store, entries: createStoreEntries(letters, (id: string) => id) };
};

/**
 * A dead-letter store held in memory.
 */
export const createMemoryDeadLetterStore: CreateMemoryDeadLetterStoreFunction = () =>
  createKeptDeadLetterStore().store;
