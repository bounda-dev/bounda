import {
  erased,
  type IdempotencyRecord,
  type IdempotencyStore,
} from "../adapter/storage/idempotency-store.ts";
import { type KeyedPerson, namesPerson } from "../adapter/storage/personal-key-store.ts";
import { IdempotencyKeyTakenError } from "../contracts/errors.ts";
import { createStoreEntries, type WithEntries } from "./entries.ts";
import { jsonCopy } from "./json-copy.ts";

export interface CreateKeptIdempotencyStoreArgs {
  /**
   * Whether a person holds the key a record names; synchronous, so `put` checks and writes in one
   * step.
   */
  readonly holds: (held: KeyedPerson) => boolean;
}

export interface CreateKeptIdempotencyStoreFunction {
  (args: CreateKeptIdempotencyStoreArgs): WithEntries<IdempotencyStore, string>;
}

const expired = (record: IdempotencyRecord, now: Date): boolean =>
  new Date(record.expiresAt).getTime() <= now.getTime();

const copy = (record: IdempotencyRecord): IdempotencyRecord => ({
  ...record,
  answer: jsonCopy(record.answer),
});

export const createKeptIdempotencyStore: CreateKeptIdempotencyStoreFunction = ({ holds }) => {
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
      records.set(record.key, copy(record.persons.every(holds) ? record : erased(record)));
    },
    listByPerson: async ({ person, now }) =>
      [...records.values()]
        .filter((record) => !expired(record, now) && namesPerson(record, person))
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .map(copy),
    list: async ({ now, limit, offset = 0 }) =>
      [...records.values()]
        .filter((record) => !expired(record, now))
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .slice(offset, limit === undefined ? undefined : offset + limit)
        .map(copy),
    erase: async ({ key, filed = key, now }) => {
      const record = records.get(key);
      if (record === undefined || expired(record, now)) return;
      const existing = records.get(filed);
      if (filed !== key) records.delete(key);
      if (filed === key || existing === undefined || expired(existing, now)) {
        records.set(filed, erased({ ...record, key: filed }));
      }
    },
    clear: async () => {
      records.clear();
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
    forget: async (person, keep) => {
      for (const [key, record] of records) {
        if (namesPerson(record, person, keep)) records.set(key, erased(record));
      }
    },
  };
  return { store, entries: createStoreEntries(records, (key: string) => key) };
};
