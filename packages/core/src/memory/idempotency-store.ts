import type { IdempotencyRecord, IdempotencyStore } from "../adapter/storage/idempotency-store.ts";
import { IdempotencyKeyTakenError } from "../contracts/errors.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";
import { jsonCopy } from "./json-copy.ts";

export interface CreateMemoryIdempotencyStoreFunction {
  (): IdempotencyStore;
}

export interface CreateKeptIdempotencyStoreFunction {
  (): WithEntries<IdempotencyStore, string>;
}

const expired = (record: IdempotencyRecord, now: Date): boolean =>
  new Date(record.expiresAt).getTime() <= now.getTime();

const copy = (record: IdempotencyRecord): IdempotencyRecord => ({
  ...record,
  outcome: jsonCopy(record.outcome),
});

export const createKeptIdempotencyStore: CreateKeptIdempotencyStoreFunction = () => {
  const records = new Map<string, IdempotencyRecord>();

  const store: IdempotencyStore = {
    get: async ({ key, now }) => {
      const record = records.get(key);
      return record === undefined || expired(record, now) ? null : copy(record);
    },
    put: async ({ now, ...record }) => {
      const existing = records.get(record.key);
      if (existing !== undefined && !expired(existing, now)) {
        throw new IdempotencyKeyTakenError(record.key);
      }
      records.set(record.key, copy(record));
    },
    purge: async ({ now }) => {
      let purged = 0;
      for (const [key, record] of records) {
        if (!expired(record, now)) continue;
        records.delete(key);
        purged += 1;
      }
      return purged;
    },
  };
  return { store, entries: createStoreEntries(records, (key: string) => key) };
};

export const createMemoryIdempotencyStore: CreateMemoryIdempotencyStoreFunction = () =>
  createKeptIdempotencyStore().store;
