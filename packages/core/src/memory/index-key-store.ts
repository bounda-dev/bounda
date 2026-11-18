import type { IndexKeyStore } from "../adapter/storage/index-key-store.ts";
import type { StoredPersonalKey } from "../adapter/storage/personal-key-store.ts";

export interface MemoryIndexKeyStore extends IndexKeyStore {
  rows(): readonly Readonly<Record<string, unknown>>[];
}

export interface CreateMemoryIndexKeyStoreFunction {
  (): MemoryIndexKeyStore;
}

interface Held {
  readonly key: StoredPersonalKey;
  readonly createdAt: string;
}

const isKey = (held: Held | null, key: StoredPersonalKey): held is Held =>
  held !== null && held.key.fingerprint === key.fingerprint && held.key.key === key.key;

const rowOf = (scope: string, held: Held | null): readonly Readonly<Record<string, unknown>>[] =>
  held === null
    ? []
    : [
        {
          scope,
          fingerprint: held.key.fingerprint,
          key: held.key.key,
          kid: held.key.kid,
          created_at: held.createdAt,
        },
      ];

export const createMemoryIndexKeyStore: CreateMemoryIndexKeyStoreFunction = () => {
  let held: Held | null = null;
  let previous: Held | null = null;
  return {
    get: async () => held?.key ?? null,
    previous: async () => previous?.key ?? null,
    add: async (key, at) => {
      held ??= { key, createdAt: at.toISOString() };
      return held.key;
    },
    clear: async () => {
      held = null;
      previous = null;
    },
    replace: async (from, to) => {
      if (!isKey(held, from)) return false;
      held = { ...held, key: to };
      return true;
    },
    rewrap: async (from, to) => {
      if (isKey(held, from)) {
        held = { ...held, key: { ...held.key, ...to } };
        return true;
      }
      if (!isKey(previous, from)) return false;
      previous = { ...previous, key: { ...previous.key, ...to } };
      return true;
    },
    supersede: async (from, to, kept, at) => {
      if (!isKey(held, from)) return false;
      previous ??= { ...held, key: { ...held.key, ...kept } };
      if (previous.key.fingerprint !== from.fingerprint) return false;
      held = { key: to, createdAt: at.toISOString() };
      return true;
    },
    dropPrevious: async (key) => {
      if (!isKey(previous, key)) return false;
      previous = null;
      return true;
    },
    rows: () => [...rowOf("app", held), ...rowOf("previous", previous)],
  };
};
