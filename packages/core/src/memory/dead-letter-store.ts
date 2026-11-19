import { byFirstFailure } from "../adapter/sql/dead-letters.ts";
import { codePointOrder } from "../adapter/sql/order.ts";
import type {
  DeadLetterStore,
  FailedDeadLetters,
  ListDeadLettersArgs,
  StoredDeadLetter,
} from "../adapter/storage/dead-letter-store.ts";
import { pageByKey } from "../adapter/storage/person-page.ts";
import { namesPerson } from "../adapter/storage/personal-key-store.ts";
import { DeadLetterSettledError } from "../contracts/errors.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";
import { jsonCopy } from "./json-copy.ts";

export interface CreateKeptDeadLetterStoreArgs {
  /**
   * Whether the person holds a restriction, answered at once, so `purge` and `removeHeld` check it
   * in the step that removes.
   */
  readonly restricted: (person: string) => boolean;
}

export interface CreateKeptDeadLetterStoreFunction {
  (args: CreateKeptDeadLetterStoreArgs): WithEntries<DeadLetterStore, string>;
}

const matches = (letter: StoredDeadLetter, args: ListDeadLettersArgs): boolean =>
  (args.kind === undefined || letter.kind === args.kind) &&
  (args.handler === undefined || letter.handler === args.handler) &&
  (args.status === undefined || letter.status === args.status);

// Sealed text is an object, copied as a SQL store hands its JSON back.
const copy = ({
  payload,
  persons,
  readPersons,
  errorMessage,
  errorStack,
  ...letter
}: StoredDeadLetter): StoredDeadLetter => ({
  ...letter,
  ...(readPersons === undefined || readPersons.length === 0
    ? {}
    : { readPersons: [...readPersons] }),
  errorMessage: jsonCopy(errorMessage),
  ...(errorStack === undefined ? {} : { errorStack: jsonCopy(errorStack) }),
  ...(payload === undefined ? {} : { payload: jsonCopy(payload) }),
  ...(persons === undefined || persons.length === 0 ? {} : { persons: jsonCopy(persons) }),
});

interface Resolved extends StoredDeadLetter {
  readonly resolvedAt: string;
}

export const createKeptDeadLetterStore: CreateKeptDeadLetterStoreFunction = ({ restricted }) => {
  const letters = new Map<string, StoredDeadLetter>();
  const held = ({ person, statePerson, readPersons = [], persons = [] }: StoredDeadLetter) =>
    [person, statePerson, ...readPersons, ...persons.map((named) => named.person)].some(
      (named) => named !== null && named !== undefined && restricted(named),
    );

  const select = (args: ListDeadLettersArgs): StoredDeadLetter[] =>
    [...letters.values()].filter((letter) => matches(letter, args)).sort(byFirstFailure);

  // Earliest `resolvedAt` first, then by `id`, as the SQL stores order them.
  const resolved = (): Resolved[] =>
    [...letters.values()]
      .filter((letter): letter is Resolved => letter.resolvedAt !== undefined)
      .sort((a, b) => codePointOrder(a.resolvedAt, b.resolvedAt) || codePointOrder(a.id, b.id));

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
    listFailed: async ({ person, errorCode }) =>
      select({ status: "failed" })
        .filter((letter) => letter.person === person && letter.errorCode === errorCode)
        .map(copy),
    updateStatus: async (id, status, at) => {
      const existing = letters.get(id);
      if (existing?.status !== "failed") throw new DeadLetterSettledError({ id });
      letters.set(id, { ...existing, status, resolvedAt: at.toISOString() });
    },
    remove: async (id) => {
      letters.delete(id);
    },
    reseal: async (
      id,
      { person, statePerson, readPersons, errorMessage, errorStack, payload, persons },
    ) => {
      const existing = letters.get(id);
      if (existing === undefined) return;
      const {
        errorStack: _stack,
        payload: _payload,
        persons: _persons,
        statePerson: _statePerson,
        readPersons: _readPersons,
        ...kept
      } = existing;
      letters.set(
        id,
        copy({
          ...kept,
          person,
          ...(statePerson === undefined ? {} : { statePerson }),
          ...(readPersons === undefined ? {} : { readPersons }),
          errorMessage,
          ...(errorStack === undefined ? {} : { errorStack }),
          ...(payload === undefined ? {} : { payload }),
          ...(persons === undefined ? {} : { persons }),
        }),
      );
    },
    listByPerson: async ({ person, ...page }) =>
      pageByKey(
        select({}).filter(
          (letter) =>
            letter.person === person ||
            letter.statePerson === person ||
            letter.readPersons?.includes(person) === true ||
            namesPerson(letter, person),
        ),
        ({ id }) => id,
        page,
      ).map(copy),
    forget: async (person, keep) => {
      const named = select({}).filter((letter) => namesPerson(letter, person, keep));
      for (const { id } of named) letters.delete(id);
      return named.map(copy);
    },
    firstResolvedAt: async () => {
      const [first] = resolved().filter((letter) => !held(letter));
      return first === undefined ? null : new Date(first.resolvedAt);
    },
    firstHeldAt: async () => {
      const [first] = resolved().filter(held);
      return first === undefined ? null : new Date(first.resolvedAt);
    },
    purge: async ({ resolvedBy, limit }) => {
      const due = resolved()
        .filter((letter) => Date.parse(letter.resolvedAt) <= resolvedBy.getTime() && !held(letter))
        .slice(0, limit);
      for (const { id } of due) letters.delete(id);
      return due.length;
    },
    listHeld: async ({ resolvedBy, after, limit }) =>
      resolved()
        .filter(
          (letter) =>
            Date.parse(letter.resolvedAt) <= resolvedBy.getTime() &&
            held(letter) &&
            (after === undefined || codePointOrder(letter.id, after) > 0),
        )
        .sort((a, b) => codePointOrder(a.id, b.id))
        .slice(0, limit)
        .map(copy),
    removeHeld: async (letter, unlessRestricted) => {
      const kept = letters.get(letter.id);
      if (
        kept?.resolvedAt === undefined ||
        kept.resolvedAt !== letter.resolvedAt ||
        JSON.stringify(kept.errorMessage) !== JSON.stringify(letter.errorMessage) ||
        JSON.stringify(kept.persons ?? []) !== JSON.stringify(letter.persons ?? []) ||
        unlessRestricted.some(restricted)
      ) {
        return false;
      }
      letters.delete(letter.id);
      return true;
    },
    failedByHandler: async () => {
      const counts = new Map<string, FailedDeadLetters>();
      for (const { kind, handler } of select({ status: "failed" })) {
        const key = JSON.stringify([kind, handler]);
        counts.set(key, { kind, handler, count: (counts.get(key)?.count ?? 0) + 1 });
      }
      return [...counts.values()].sort(
        (a, b) => codePointOrder(a.kind, b.kind) || codePointOrder(a.handler, b.handler),
      );
    },
    clear: async (keepEventId) => {
      for (const [id, { eventId }] of letters) if (eventId !== keepEventId) letters.delete(id);
    },
  };
  return { store, entries: createStoreEntries(letters, (id: string) => id) };
};
