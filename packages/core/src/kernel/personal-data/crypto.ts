import type { StoredPersonalKey } from "../../adapter/storage/personal-key-store.ts";

const ALGORITHM = "AES-GCM";
const KEY_BITS = 256;
const IV_BYTES = 12;

/**
 * A personal field as it is stored: the ciphertext, its nonce, the person whose key opens it and
 * the fingerprint of that key, so a value sealed under a key the person no longer has is told
 * from one their current key opens.
 */
export interface PersonalEnvelope {
  readonly person: string;
  readonly key: string;
  readonly iv: string;
  readonly data: string;
}

/**
 * A person's key as the store uses it, with the fingerprint envelopes name it by.
 */
export interface PersonalKey {
  readonly fingerprint: string;
  readonly cryptoKey: CryptoKey;
}

/**
 * A stored field value that holds personal data: nothing but the envelope, under a key no schema
 * field takes.
 */
export interface SealedValue {
  readonly $personal: PersonalEnvelope;
}

export interface IsSealedFunction {
  (value: unknown): value is SealedValue;
}

export const isSealed: IsSealedFunction = (value): value is SealedValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const envelope: unknown = Reflect.get(value, "$personal");
  return (
    keys.length === 1 &&
    keys[0] === "$personal" &&
    typeof envelope === "object" &&
    envelope !== null &&
    typeof Reflect.get(envelope, "person") === "string" &&
    typeof Reflect.get(envelope, "key") === "string" &&
    typeof Reflect.get(envelope, "iv") === "string" &&
    typeof Reflect.get(envelope, "data") === "string"
  );
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

export interface GeneratePersonalKeyFunction {
  (): Promise<StoredPersonalKey>;
}

/**
 * A fresh key, as the key store keeps it: the raw key and its SHA-256, both in base64.
 */
export const generatePersonalKey: GeneratePersonalKeyFunction = async () => {
  const key = await crypto.subtle.generateKey({ name: ALGORITHM, length: KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return { key: toBase64(raw), fingerprint: toBase64(new Uint8Array(digest)) };
};

export interface ImportPersonalKeyFunction {
  (stored: StoredPersonalKey): Promise<PersonalKey>;
}

export const importPersonalKey: ImportPersonalKeyFunction = async ({ key, fingerprint }) => ({
  fingerprint,
  cryptoKey: await crypto.subtle.importKey("raw", fromBase64(key), ALGORITHM, false, [
    "encrypt",
    "decrypt",
  ]),
});

export interface SealArgs {
  readonly key: PersonalKey;
  readonly person: string;
  readonly value: unknown;
}

export interface SealFunction {
  (args: SealArgs): Promise<SealedValue>;
}

/**
 * Encrypts `value` as JSON, under a nonce of its own, so equal values never store alike.
 */
export const seal: SealFunction = async ({ key, person, value }) => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key.cryptoKey,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    $personal: {
      person,
      key: key.fingerprint,
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(encrypted)),
    },
  };
};

export interface UnsealArgs {
  readonly key: PersonalKey | null;
  readonly sealed: SealedValue;
}

export interface UnsealFunction {
  (args: UnsealArgs): Promise<unknown>;
}

/**
 * `null` without a key, or with one the value was not sealed under: the person was forgotten,
 * and may have been given a new key since. A value the key should open and does not throws.
 */
export const unseal: UnsealFunction = async ({ key, sealed: { $personal: envelope } }) => {
  if (key === null || key.fingerprint !== envelope.key) return null;
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: fromBase64(envelope.iv) },
    key.cryptoKey,
    fromBase64(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as unknown;
};
