import type { IndexKeyStore } from "../adapter/storage/index-key-store.ts";
import type { StoredPersonalKey } from "../adapter/storage/personal-key-store.ts";

export interface MemoryIndexKeyStore extends IndexKeyStore {
  rows(): readonly Readonly<Record<string, unknown>>[];
}

export interface CreateMemoryIndexKeyStoreFunction {
  (): MemoryIndexKeyStore;
}

export const createMemoryIndexKeyStore: CreateMemoryIndexKeyStoreFunction = () => {
  let held: { readonly key: StoredPersonalKey; readonly createdAt: string } | null = null;
  return {
    get: async () => held?.key ?? null,
    add: async (key, at) => {
      held ??= { key, createdAt: at.toISOString() };
      return held.key;
    },
    rewrap: async (from, to) => {
      if (held === null || held.key.fingerprint !== from.fingerprint || held.key.key !== from.key) {
        return false;
      }
      held = { ...held, key: { ...held.key, ...to } };
      return true;
    },
    rows: () =>
      held === null
        ? []
        : [
            {
              scope: "app",
              fingerprint: held.key.fingerprint,
              key: held.key.key,
              kid: held.key.kid,
              created_at: held.createdAt,
            },
          ],
  };
};
