import { byFirstFailure } from "../adapter/sql/dead-letters.ts";
import type {
  DeadLetterStore,
  ListDeadLettersArgs,
  StoredDeadLetter,
} from "../adapter/storage/dead-letter-store.ts";
import { namesPerson } from "../adapter/storage/personal-key-store.ts";
import { DeadLetterSettledError } from "../contracts/errors.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";
import { jsonCopy } from "./json-copy.ts";

export interface CreateMemoryDeadLetterStoreFunction {
  (): DeadLetterStore;
}

export interface CreateKeptDeadLetterStoreFunction {
  (): WithEntries<DeadLetterStore, string>;
}

const matches = (letter: StoredDeadLetter, args: ListDeadLettersArgs): boolean =>
  (args.kind === undefined || letter.kind === args.kind) &&
  (args.handler === undefined || letter.handler === args.handler) &&
  (args.status === undefined || letter.status === args.status);

// Sealed text is an object, copied as a SQL store hands its JSON back.
const copy = ({
  payload,
  persons,
  errorMessage,
  errorStack,
  ...letter
}: StoredDeadLetter): StoredDeadLetter => ({
  ...letter,
  errorMessage: jsonCopy(errorMessage),
  ...(errorStack === undefined ? {} : { errorStack: jsonCopy(errorStack) }),
  ...(payload === undefined ? {} : { payload: jsonCopy(payload) }),
  ...(persons === undefined || persons.length === 0 ? {} : { persons: jsonCopy(persons) }),
});

export const createKeptDeadLetterStore: CreateKeptDeadLetterStoreFunction = () => {
  const letters = new Map<string, StoredDeadLetter>();

  const select = (args: ListDeadLettersArgs): StoredDeadLetter[] =>
    [...letters.values()].filter((letter) => matches(letter, args)).sort(byFirstFailure);

  const store: DeadLetterStore = {
    add: async (letter) => {
      const existing = letters.get(letter.id);
      if (existing !== undefined) return copy(existing);
      const stored = copy({ ...letter, status: "failed" });
      letters.set(letter.id, stored);
      return copy(stored);
    },
    get: async (id) => {
      const letter = letters.get(id);
      return letter === undefined ? null : copy(letter);
    },
    list: async (args = {}) => {
      const offset = args.offset ?? 0;
      const selected = select(args);
      return selected
        .slice(offset, args.limit === undefined ? undefined : offset + args.limit)
        .map(copy);
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
    forget: async (person) => {
      const named = select({}).filter((letter) => namesPerson(letter, person));
      for (const { id } of named) letters.delete(id);
      return named.map(copy);
    },
  };
  return { store, entries: createStoreEntries(letters, (id: string) => id) };
};

export const createMemoryDeadLetterStore: CreateMemoryDeadLetterStoreFunction = () =>
  createKeptDeadLetterStore().store;
