import type { IndexKeyStore } from "../../adapter/storage/index-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { FieldType } from "../../modules/view.ts";
import { PERSONAL_KEY_ALGORITHM, toBase64 } from "./crypto.ts";
import type { PersonalKeyWrapping } from "./wrapped-keys.ts";

// The nonce the index key is derived under: its top bit is clear, so `seal` never draws it, and it
// is not the fingerprint's, all zeroes. Encrypting one fixed block under it yields the same secret
// bytes every time, and nothing else is ever encrypted under it.
const DERIVATION_IV = Uint8Array.from({ length: 12 }, (_, index) => (index === 11 ? 1 : 0));
const HMAC_KEY_BYTES = 32;

// Computes the blind index of a value: an HMAC-SHA256 under the database's index key, of the value
// as its field stores it, apart for each read model and field, so one person's email in two read
// models indexes differently.
export interface BlindIndexer {
  index(args: BlindIndexArgs): Promise<string>;
}

export interface BlindIndexArgs {
  readonly readModel: string;
  readonly field: string;
  readonly type: FieldType;
  readonly value: unknown;
}

// Object keys in code-unit order at every depth, so two equal JSON values index alike.
const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null || value instanceof Date) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => [key, canonicalJson(Reflect.get(value, key))]),
  );
};

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

const deriveHmacKey = async (key: CryptoKey): Promise<CryptoKey> => {
  const derived = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: PERSONAL_KEY_ALGORITHM, iv: DERIVATION_IV },
      key,
      new Uint8Array(HMAC_KEY_BYTES),
    ),
  ).slice(0, HMAC_KEY_BYTES);
  try {
    return await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
  } finally {
    derived.fill(0);
  }
};

export interface OpenBlindIndexerArgs {
  readonly store: IndexKeyStore;
  readonly wrapping: Pick<PersonalKeyWrapping, "generate" | "unwrap" | "wrapped" | "wrapper">;
  readonly clock: Clock;
}

export interface OpenBlindIndexerFunction {
  (args: OpenBlindIndexerArgs): Promise<BlindIndexer>;
}

// The database's index key, created on first use and kept wrapped as a person's key is, so a copy
// of the database computes no index without the key wrapper; a key wrapped under a previous key of
// the wrapper is rewrapped at once.
export const openBlindIndexer: OpenBlindIndexerFunction = async ({ store, wrapping, clock }) => {
  let stored = await store.get();
  if (stored === null) {
    const generated = await wrapping.generate();
    stored = await store.add(generated.stored, clock.now());
  }
  if (wrapping.wrapper !== null && stored.kid !== wrapping.wrapper.kid) {
    const rewrapped = await wrapping.wrapped(stored);
    if (await store.rewrap(stored, rewrapped)) stored = { ...stored, ...rewrapped };
  }
  const key = await deriveHmacKey(await wrapping.unwrap(stored));
  return {
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
};
