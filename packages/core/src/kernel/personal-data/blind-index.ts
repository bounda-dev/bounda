import type { IndexKeyStore } from "../../adapter/storage/index-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { FieldType } from "../../modules/view.ts";
import { canonicalJson } from "../shared/value-search.ts";
import { type AtRestSealer, createAtRestSealer } from "./at-rest.ts";
import { toBase64 } from "./crypto.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

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
}

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
  readonly atRest: AtRestSealer;
}

export interface OpenDatabaseKeyArgs {
  readonly store: IndexKeyStore;
  readonly wrapping: Pick<
    PersonalKeyWrapping,
    "generate" | "wrapped" | "isTenantWrapped" | "derivationBase"
  >;
  readonly clock: Clock;
}

export interface OpenDatabaseKeyFunction {
  (args: OpenDatabaseKeyArgs): Promise<DatabaseKey>;
}

// The database's key, created on first use and kept wrapped under the tenant's key as a person's
// key is, so a copy of the database computes no index and opens nothing sealed at rest without
// it; a key wrapped under an older version is rewrapped at once. One a version of Bounda before
// tenant keys created is replaced by a new one: the indexes it computed are computed anew, by the
// read models' settling, since the derivation changed with it.
export const openDatabaseKey: OpenDatabaseKeyFunction = async ({ store, wrapping, clock }) => {
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
  if (rewrapped.kid !== stored.kid && (await store.rewrap(stored, rewrapped))) {
    stored = { ...stored, ...rewrapped };
  }
  const base = await wrapping.derivationBase(stored);
  const key = await deriveHmacKey(base);
  const atRest = createAtRestSealer(base);
  const indexer: BlindIndexer = {
    epoch: stored.fingerprint,
    index: async ({ readModel, field, type, value }) =>
      toBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(`${readModel}\u0000${field}\u0000${indexedText(type, value)}`),
          ),
        ),
      ),
  };
  return { indexer, atRest };
};
