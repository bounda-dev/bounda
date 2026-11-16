import {
  DEFAULT_PERSONAL_CATEGORY,
  type PersonalEnvelope,
  type SealedValue,
} from "../../adapter/storage/personal-key-store.ts";
import { ValidationError } from "../../contracts/errors.ts";

export type { PersonalEnvelope, SealedValue };

export const PERSONAL_KEY_ALGORITHM = "AES-GCM";
const KEY_BITS = 256;
const IV_BYTES = 12;

/**
 * A person's key as the kernel seals and opens with it, with the fingerprint envelopes name it by,
 * and whether a forgetting kept it past it, as the store said when it was read. The key can never
 * be exported: its raw bytes are not reachable from JavaScript.
 */
export interface PersonalKey {
  readonly fingerprint: string;
  readonly cryptoKey: CryptoKey;
  readonly retained: boolean;
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
    ["string", "undefined"].includes(typeof Reflect.get(envelope, "category")) &&
    typeof Reflect.get(envelope, "key") === "string" &&
    typeof Reflect.get(envelope, "iv") === "string" &&
    typeof Reflect.get(envelope, "data") === "string"
  );
};

const sealedFieldOf = (payload: Record<string, unknown>): string | null => {
  for (const field in payload) {
    if (isSealed(payload[field])) return field;
  }
  return null;
};

export interface HoldsSealedFunction {
  (payload: Record<string, unknown>): boolean;
}

export const holdsSealed: HoldsSealedFunction = (payload) => sealedFieldOf(payload) !== null;

export interface RefuseSealedArgs {
  readonly payload: Record<string, unknown>;
  /**
   * What is being stored, for the message: `Event OrderPlaced of order:o-1`.
   */
  readonly subject: string;
  readonly writer: "handler" | "caller";
}

export interface RefuseSealedFunction {
  (args: RefuseSealedArgs): void;
}

/**
 * Throws `ValidationError` when any top-level field holds an envelope. What the kernel reads is
 * opened by its shape, whatever the schema marks, so a handler or caller must never write one:
 * it would read back as `null`, or not at all under the person's current key.
 */
export const refuseSealed: RefuseSealedFunction = ({ payload, subject, writer }) => {
  const field = sealedFieldOf(payload);
  if (field === null) return;
  throw new ValidationError(
    `${subject} carries a sealed value in "${field}": personal fields are sealed by the runtime, never by a ${writer}`,
    [{ path: [field], message: "Expected a value, not an envelope" }],
  );
};

export interface ToBase64Function {
  (bytes: Uint8Array): string;
}

export const toBase64: ToBase64Function = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export interface FromBase64Function {
  (text: string): Uint8Array<ArrayBuffer>;
}

export const fromBase64: FromBase64Function = (text) =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

/**
 * The usages every personal key is created or imported with: the fingerprint is computed by
 * encrypting, so even a key only ever used to open needs both.
 */
export const PERSONAL_KEY_USAGES: readonly KeyUsage[] = ["encrypt", "decrypt"];

// The fingerprint's nonce. Every nonce `seal` draws has its top bit set, so no value is ever
// encrypted under this one: the fingerprint is the encryption of a block nothing else uses.
const FINGERPRINT_IV = new Uint8Array(IV_BYTES);
const SEAL_IV_MARK = 0x80;

export interface FingerprintOfFunction {
  (key: CryptoKey): Promise<string>;
}

/**
 * What names a key in envelopes and in the key store, in base64: the AES-GCM tag of nothing under
 * a nonce reserved for it, a key check value. It reveals nothing of the key and is computed from
 * the key itself, so a key that can never be exported is fingerprinted, and checked against its
 * fingerprint, all the same.
 */
export const fingerprintOf: FingerprintOfFunction = async (key) =>
  toBase64(
    new Uint8Array(
      await crypto.subtle.encrypt(
        { name: PERSONAL_KEY_ALGORITHM, iv: FINGERPRINT_IV },
        key,
        new Uint8Array(),
      ),
    ),
  );

export interface GenerateWrappableKeyFunction {
  (): Promise<CryptoKey>;
}

/**
 * A fresh key that can be exported, so it can be wrapped: never used to seal, never kept past
 * wrapping it.
 */
export const generateWrappableKey: GenerateWrappableKeyFunction = async () =>
  crypto.subtle.generateKey({ name: PERSONAL_KEY_ALGORITHM, length: KEY_BITS }, true, [
    ...PERSONAL_KEY_USAGES,
  ]);

export interface CreateDisposableKeyFunction {
  (): Promise<PersonalKey>;
}

/**
 * A fresh key no store keeps, which cannot be exported: what is sealed under it can never be
 * opened once it is let go.
 */
export const createDisposableKey: CreateDisposableKeyFunction = async () => {
  const cryptoKey = await crypto.subtle.generateKey(
    { name: PERSONAL_KEY_ALGORITHM, length: KEY_BITS },
    false,
    [...PERSONAL_KEY_USAGES],
  );
  return { fingerprint: await fingerprintOf(cryptoKey), cryptoKey, retained: false };
};

/**
 * What a key is for: a person's or the database's, which seals and opens values, or a tenant's,
 * which only wraps and unwraps those.
 */
export type KeyKind = "personal" | "tenant";

export const TENANT_KEY_ALGORITHM = "AES-KW";

/**
 * The usages of a tenant key: it never seals a value, only wraps the keys that do.
 */
export const TENANT_KEY_USAGES: readonly KeyUsage[] = ["wrapKey", "unwrapKey"];

export interface KeyAlgorithmOfFunction {
  (kind: KeyKind): { readonly name: string; readonly usages: readonly KeyUsage[] };
}

export const keyAlgorithmOf: KeyAlgorithmOfFunction = (kind) =>
  kind === "tenant"
    ? { name: TENANT_KEY_ALGORITHM, usages: TENANT_KEY_USAGES }
    : { name: PERSONAL_KEY_ALGORITHM, usages: PERSONAL_KEY_USAGES };

export interface ImportRawKeyArgs {
  /**
   * Zeroed once imported, imported or not.
   */
  readonly raw: Uint8Array;
  readonly extractable: boolean;
  /**
   * Defaults to `"personal"`.
   */
  readonly kind?: KeyKind;
}

export interface ImportRawKeyFunction {
  (args: ImportRawKeyArgs): Promise<CryptoKey>;
}

export const importRawKey: ImportRawKeyFunction = async ({
  raw,
  extractable,
  kind = "personal",
}) => {
  const copy = Uint8Array.from(raw);
  const { name, usages } = keyAlgorithmOf(kind);
  try {
    return await crypto.subtle.importKey("raw", copy, name, extractable, [...usages]);
  } finally {
    copy.fill(0);
    raw.fill(0);
  }
};

export interface GenerateWrappableTenantKeyFunction {
  (): Promise<CryptoKey>;
}

/**
 * A fresh tenant key that can be exported, so the master key can wrap it: never used to wrap a
 * key, never kept past wrapping it.
 */
export const generateWrappableTenantKey: GenerateWrappableTenantKeyFunction = async () =>
  crypto.subtle.generateKey({ name: TENANT_KEY_ALGORITHM, length: KEY_BITS }, true, [
    ...TENANT_KEY_USAGES,
  ]);

// What a tenant key's check value wraps: a key every byte of which is zero, which nothing else uses.
const CHECK_KEY_BYTES = 16;

export interface TenantFingerprintOfFunction {
  (key: CryptoKey): Promise<string>;
}

/**
 * A tenant key's check value, in base64: the AES-KW wrapping of a key of zeroes, which reveals
 * nothing of the key and is computed from the key itself, so one that can never be exported is
 * checked all the same.
 */
// A public constant, imported once a process: no secret goes through it.
let checkKey: Promise<CryptoKey> | null = null;

export const tenantFingerprintOf: TenantFingerprintOfFunction = async (key) => {
  checkKey ??= crypto.subtle.importKey(
    "raw",
    new Uint8Array(CHECK_KEY_BYTES),
    PERSONAL_KEY_ALGORITHM,
    true,
    ["encrypt"],
  );
  return toBase64(
    new Uint8Array(await crypto.subtle.wrapKey("raw", await checkKey, key, TENANT_KEY_ALGORITHM)),
  );
};

export interface WrapUnderTenantKeyFunction {
  (key: CryptoKey, tenantKey: CryptoKey): Promise<Uint8Array>;
}

/**
 * `key`, which must be exportable, wrapped under a tenant key by WebCrypto: its raw bytes never
 * reach JavaScript.
 */
export const wrapUnderTenantKey: WrapUnderTenantKeyFunction = async (key, tenantKey) =>
  new Uint8Array(await crypto.subtle.wrapKey("raw", key, tenantKey, TENANT_KEY_ALGORITHM));

export interface UnwrapUnderTenantKeyArgs {
  readonly wrapped: Uint8Array;
  readonly tenantKey: CryptoKey;
  /**
   * Only to wrap the key again; a key to seal and open with never is.
   */
  readonly extractable: boolean;
  /**
   * A key to seal and open with, the default, or a base keys are derived from.
   */
  readonly as?: "seal" | "derivation";
}

export interface UnwrapUnderTenantKeyFunction {
  (args: UnwrapUnderTenantKeyArgs): Promise<CryptoKey>;
}

export const unwrapUnderTenantKey: UnwrapUnderTenantKeyFunction = async ({
  wrapped,
  tenantKey,
  extractable,
  as = "seal",
}) =>
  as === "derivation"
    ? crypto.subtle.unwrapKey(
        "raw",
        Uint8Array.from(wrapped),
        tenantKey,
        TENANT_KEY_ALGORITHM,
        "HKDF",
        false,
        ["deriveKey"],
      )
    : crypto.subtle.unwrapKey(
        "raw",
        Uint8Array.from(wrapped),
        tenantKey,
        TENANT_KEY_ALGORITHM,
        PERSONAL_KEY_ALGORITHM,
        extractable,
        [...PERSONAL_KEY_USAGES],
      );

export interface WithRawKeyFunction {
  <T>(key: CryptoKey, use: (raw: Uint8Array<ArrayBuffer>) => Promise<T>): Promise<T>;
}

/**
 * Runs `use` on the raw bytes of an exportable key, and zeroes them once it settles.
 */
export const withRawKey: WithRawKeyFunction = async (key, use) => {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  try {
    return await use(raw);
  } finally {
    raw.fill(0);
  }
};

export interface SealArgs {
  readonly key: PersonalKey;
  readonly person: string;
  readonly category: string;
  readonly value: unknown;
}

export interface SealFunction {
  (args: SealArgs): Promise<SealedValue>;
}

/**
 * Encrypts `value` as JSON, under a nonce of its own, so equal values never store alike, and never
 * the fingerprint's. The envelope names the category unless it is the default one, as every
 * envelope sealed before categories existed reads.
 */
export const seal: SealFunction = async ({ key, person, category, value }) => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  iv[0] = (iv[0] ?? 0) | SEAL_IV_MARK;
  const encrypted = await crypto.subtle.encrypt(
    { name: PERSONAL_KEY_ALGORITHM, iv },
    key.cryptoKey,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    $personal: {
      person,
      ...(category === DEFAULT_PERSONAL_CATEGORY ? {} : { category }),
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

export interface CategoryOfFunction {
  (sealed: SealedValue): string;
}

export const categoryOf: CategoryOfFunction = ({ $personal }) =>
  $personal.category ?? DEFAULT_PERSONAL_CATEGORY;

/**
 * `null` without a key, or with one the value was not sealed under: the person was forgotten,
 * and may have been given a new key since. A value the key should open and does not throws.
 */
export const unseal: UnsealFunction = async ({ key, sealed: { $personal: envelope } }) => {
  if (key === null || key.fingerprint !== envelope.key) return null;
  const decrypted = await crypto.subtle.decrypt(
    { name: PERSONAL_KEY_ALGORITHM, iv: fromBase64(envelope.iv) },
    key.cryptoKey,
    fromBase64(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as unknown;
};
