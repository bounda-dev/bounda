import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import type { IndexKeyStore } from "../../adapter/storage/index-key-store.ts";
import type { StoredPersonalKey } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { TenantFrozenError } from "../../contracts/errors.ts";
import type { FieldType } from "../../modules/view.ts";
import { canonicalJson } from "../shared/value-search.ts";
import { type AtRestSealer, createAtRestSealer } from "./at-rest.ts";
import { toBase64 } from "./crypto.ts";
import { type PersonalKeyWrapping, UNWRAPPED_KEY_TTL_MS } from "./wrapped-keys.ts";

const INDEX_INFO = new TextEncoder().encode("bounda:blind-index");

// Computes the blind index of a value: an HMAC-SHA256 under a key derived from the database's key,
// of the value as its field stores it, apart for each read model and field, so one person's email
// in two read models indexes differently.
export interface BlindIndexer {
  index(args: BlindIndexArgs): Promise<string>;
  /**
   * The fingerprint of the database's key the indexes are computed under: indexes of another
   * epoch compare to nothing.
   */
  readonly epoch: string;
  /**
   * The indexer of a read model's table, under the key its rows are indexed under: this one but
   * while a reseal keeps the previous key, and the table was not rebuilt under the new one yet.
   */
  forTable(table: IndexedTable): Promise<BlindIndexer>;
  /**
   * This indexer held to the key in force now, with the number its epoch mark takes: what a
   * rebuild indexes its whole table under.
   */
  pinned(): Promise<PinnedIndexer>;
  /**
   * The value's index under every key a table may be indexed under: the one in force, and the
   * previous one while a reseal keeps it. A table is indexed under one of them, so a query that
   * matches any finds its rows, whichever.
   */
  indexAll(args: BlindIndexArgs): Promise<readonly string[]>;
}

export interface PinnedIndexer extends BlindIndexer {
  readonly number: number;
}

/**
 * A read model's table, as `forTable` tells which key its rows are indexed under: the epoch mark
 * its database keeps, `epochMark(readModel)`, set by the rebuild that wrote the table, or else
 * the key in force for an empty table and the previous one for any other, which `forTable` marks
 * when it may write.
 */
export interface IndexedTable {
  readonly readModel: string;
  readonly checkpoints: Pick<CheckpointStore, "get" | "set">;
  readonly isEmpty: () => Promise<boolean>;
  /**
   * Whether the call is part of a transaction that writes the table, so it may set the mark.
   */
  readonly writes: boolean;
}

export interface EpochMarkFunction {
  (readModel: string): string;
}

/**
 * The checkpoint of a read model's database that says, as `epochNumber` does, which key the
 * table's rows are indexed under.
 */
export const epochMark: EpochMarkFunction = (readModel) => `read-model:epoch:${readModel}`;

export interface EpochNumberFunction {
  (fingerprint: string): Promise<number>;
}

/**
 * The fingerprint of a database's key as a checkpoint keeps it: a positive 31-bit number from its
 * SHA-256, never 0, which a checkpoint never set reads. A reseal draws a new key until its number
 * differs from the previous one's.
 */
export const epochNumber: EpochNumberFunction = async (fingerprint) => {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint)),
  );
  const value =
    (((hash[0] ?? 0) << 24) | ((hash[1] ?? 0) << 16) | ((hash[2] ?? 0) << 8) | (hash[3] ?? 0)) &
    0x7fffffff;
  return value === 0 ? 1 : value;
};

export interface BlindIndexArgs {
  readonly readModel: string;
  readonly field: string;
  readonly type: FieldType;
  readonly value: unknown;
}

export interface IndexedTextFunction {
  (type: FieldType, value: unknown): string;
}

// The text a value is indexed by: its JSON, a date as its ISO string, a JSON field with its keys in
// order.
export const indexedText: IndexedTextFunction = (type, value) => {
  if (type === "date") {
    return JSON.stringify((value instanceof Date ? value : new Date(String(value))).toISOString());
  }
  return JSON.stringify(type === "json" ? canonicalJson(value) : value);
};

// Derived by WebCrypto from a base the database's key was unwrapped into: no byte of either
// reaches JavaScript.
const deriveHmacKey = (base: CryptoKey): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: INDEX_INFO },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );

export interface DatabaseKey {
  readonly indexer: BlindIndexer;
  readonly atRest: DatabaseSealer;
  /**
   * Reads the database's keys again now, and opens one this instance did not know.
   */
  refresh(): Promise<void>;
}

/**
 * What the database's keys seal at rest with: under the key in force, opened under the previous
 * one too while it is kept, and keys filed under the HMAC of the key in force, found under either.
 */
export interface DatabaseSealer extends AtRestSealer {
  /**
   * Every place a key may be filed under: under the key in force first.
   */
  lookups(key: string): Promise<readonly string[]>;
}

export interface OpenDatabaseKeyArgs {
  readonly store: IndexKeyStore;
  readonly wrapping: Pick<
    PersonalKeyWrapping,
    "generate" | "wrapped" | "isTenantWrapped" | "derivationBase"
  >;
  readonly clock: Clock;
  /**
   * How long what the store said is taken as true before a call reads it again. Defaults to
   * `UNWRAPPED_KEY_TTL_MS`, the time every instance has to learn of a reseal's new key.
   */
  readonly ttlMs?: number;
}

export interface OpenDatabaseKeyFunction {
  (args: OpenDatabaseKeyArgs): Promise<DatabaseKey>;
}

interface OpenedKey {
  readonly fingerprint: string;
  readonly number: number;
  readonly hmac: CryptoKey;
  readonly atRest: AtRestSealer;
}

const openedKey = async (
  stored: StoredPersonalKey,
  wrapping: Pick<PersonalKeyWrapping, "derivationBase">,
): Promise<OpenedKey> => {
  const base = await wrapping.derivationBase(stored);
  return {
    fingerprint: stored.fingerprint,
    number: await epochNumber(stored.fingerprint),
    hmac: await deriveHmacKey(base),
    atRest: createAtRestSealer(base),
  };
};

const indexWith = async (
  key: OpenedKey,
  { readModel, field, type, value }: BlindIndexArgs,
): Promise<string> =>
  toBase64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key.hmac,
        new TextEncoder().encode(`${readModel}\u0000${field}\u0000${indexedText(type, value)}`),
      ),
    ),
  );

const unlessFrozen = (error: unknown): false => {
  if (error instanceof TenantFrozenError) return false;
  throw error;
};

// The database's key, created on first use and kept wrapped under the tenant's key as a person's
// key is, so a copy of the database computes no index and opens nothing sealed at rest without
// it; a key wrapped under an older version is rewrapped at once. One a version of Bounda before
// tenant keys created is replaced by a new one: the indexes it computed are computed anew, by the
// read models' settling, since the derivation changed with it. A reseal puts another in force and
// keeps this one as the previous: every call reads the store again once `ttlMs` has passed since
// it last did, so each instance seals under the new key within it.
export const openDatabaseKey: OpenDatabaseKeyFunction = async ({
  store,
  wrapping,
  clock,
  ttlMs = UNWRAPPED_KEY_TTL_MS,
}) => {
  let stored = await store.get();
  for (;;) {
    if (stored === null) {
      const generated = await wrapping.generate();
      stored = await store.add(generated.stored, clock.now());
    }
    if (wrapping.isTenantWrapped(stored)) break;
    const replacement = (await wrapping.generate()).stored;
    stored = (await store.replace(stored, replacement)) ? replacement : await store.get();
  }
  const rewrapped = await wrapping.wrapped(stored);
  // A frozen tenant keeps it under the version it was under, which still opens it, until it thaws.
  if (rewrapped.kid !== stored.kid && (await store.rewrap(stored, rewrapped).catch(unlessFrozen))) {
    stored = { ...stored, ...rewrapped };
  }
  let current = await openedKey(stored, wrapping);
  const kept = await store.previous();
  let previous = kept === null ? null : await openedKey(kept, wrapping);
  let readAt = clock.now().getTime();
  let reading: Promise<void> | null = null;
  // Opened keys are kept by fingerprint, so one the store still holds is not unwrapped again.
  const reread = async (): Promise<void> => {
    const [inForce, before] = await Promise.all([store.get(), store.previous()]);
    const known = [current, ...(previous === null ? [] : [previous])];
    const opened = async (key: StoredPersonalKey): Promise<OpenedKey> =>
      known.find(({ fingerprint }) => fingerprint === key.fingerprint) ?? openedKey(key, wrapping);
    // A store emptied, as forgetting the tenant leaves it, keeps the keys this instance holds.
    if (inForce !== null) current = await opened(inForce);
    previous = before === null ? null : await opened(before);
    readAt = clock.now().getTime();
  };
  const refresh = (): Promise<void> => {
    reading ??= reread().finally(() => {
      reading = null;
    });
    return reading;
  };
  // A wall clock set back reads the store again, as one that moved past the time.
  const fresh = async (): Promise<void> => {
    const age = clock.now().getTime() - readAt;
    if (age >= ttlMs || age < 0) await refresh();
  };
  const fixed = (key: OpenedKey): PinnedIndexer => ({
    epoch: key.fingerprint,
    number: key.number,
    index: (args) => indexWith(key, args),
    forTable: async () => fixed(key),
    pinned: async () => fixed(key),
    indexAll: async (args) => [await indexWith(key, args)],
  });
  const indexer: BlindIndexer = {
    get epoch() {
      return current.fingerprint;
    },
    index: async (args) => {
      await fresh();
      return indexWith(current, args);
    },
    forTable: async ({ readModel, checkpoints, isEmpty, writes }) => {
      await fresh();
      const inForce = current;
      const before = previous;
      if (before === null) return fixed(inForce);
      const mark = await checkpoints.get(epochMark(readModel));
      if (mark === inForce.number) return fixed(inForce);
      if (mark === before.number) return fixed(before);
      // A table never marked was written before the reseal, unless it is empty yet.
      const under = (await isEmpty()) ? inForce : before;
      if (writes) await checkpoints.set(epochMark(readModel), under.number);
      return fixed(under);
    },
    pinned: async () => {
      await fresh();
      return fixed(current);
    },
    indexAll: async (args) => {
      await fresh();
      const before = previous;
      return [
        await indexWith(current, args),
        ...(before === null ? [] : [await indexWith(before, args)]),
      ];
    },
  };
  const atRest: DatabaseSealer = {
    seal: async (text) => {
      await fresh();
      return current.atRest.seal(text);
    },
    // A record sealed under the previous key fails to open under the key in force: GCM's tag says
    // which opens it.
    open: async (sealed) => {
      await fresh();
      const before = previous;
      try {
        return await current.atRest.open(sealed);
      } catch (error) {
        if (before === null) throw error;
        return before.atRest.open(sealed);
      }
    },
    lookup: async (key) => {
      await fresh();
      return current.atRest.lookup(key);
    },
    lookups: async (key) => {
      await fresh();
      const before = previous;
      return [
        await current.atRest.lookup(key),
        ...(before === null ? [] : [await before.atRest.lookup(key)]),
      ];
    },
  };
  return { indexer, atRest, refresh };
};
