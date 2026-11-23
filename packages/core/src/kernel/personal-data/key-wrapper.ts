import type { DataLocationOptions } from "../../adapter/adapter-definition.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { importRawKey, type KeyKind, withRawKey } from "./crypto.ts";

/**
 * Wraps the key of every tenant before the tenant key store keeps it, and unwraps it when the
 * runtime reads it; the tenant's key wraps the keys of its persons and of its database in turn, so
 * neither a copy of the database nor one of the tenant key store opens a personal field without
 * the master key: envelope encryption. `masterKey` is the one Bounda brings; a KMS, Vault or an
 * HSM is an implementation of this interface, given through `defineKeyWrapper`.
 *
 * The key a tenant's keys are wrapped with never changes when it is wrapped anew, so rotating the
 * master key rewrites one record per tenant and nothing in the database. The runtime holds a
 * tenant's key only as a WebCrypto key that cannot be exported: the raw bytes exist only while
 * `wrap` or `unwrap` runs, and the runtime zeroes them as soon as it settles.
 */
export interface KeyWrapper {
  /**
   * The id of the key `wrap` wraps under, kept next to every key it wraps. It names a key, never
   * holds one: it is stored in the clear.
   */
  readonly kid: string;
  /**
   * The ids of older keys `unwrap` still opens. The runtime's worker rewraps under `kid`, in the
   * background, every key wrapped under one of them, and logs once none is left, when they can
   * go. A key wrapped under an id neither here nor `kid` fails to unwrap.
   */
  readonly previous?: readonly string[];
  /**
   * Wraps the raw bytes of a tenant's key under `kid`. What it resolves is stored as it is. The
   * runtime zeroes `key` once it settles, so send the bytes and keep no copy of them.
   */
  wrap(key: Uint8Array): Promise<Uint8Array>;
  /**
   * Resolves the raw bytes `wrap` was given, for a key wrapped under `kid` or one of `previous`.
   * The runtime imports them as a key that cannot be exported and zeroes the array it receives at
   * once, so resolve one no one else reads, and keep no copy of it. It checks the key against its
   * fingerprint and refuses another key.
   */
  unwrap(args: UnwrapArgs): Promise<Uint8Array>;
}

export interface UnwrapArgs {
  readonly kid: string;
  readonly wrapped: Uint8Array;
}

export interface CreateKeyWrapperArgs {
  /**
   * The host's environment, as port implementations receive it: `process.env` in Node, the
   * Worker's bindings in a Durable Object.
   */
  readonly env: AppEnv;
}

/**
 * What `runtime.personalData.keyWrapper` holds, built by `masterKey` or `defineKeyWrapper`: the
 * runtime builds the wrapper from the host's environment when the app starts.
 */
export interface KeyWrapperDefinition {
  readonly kind: "bounda-key-wrapper";
  /**
   * Where the master key is kept, as `masterKey` or `defineKeyWrapper` declares it, such as
   * `"eu"`.
   */
  readonly location?: string;
}

export interface CryptoUnwrapArgs extends UnwrapArgs {
  /**
   * Only to wrap the key again; a key to seal and open with never is.
   */
  readonly extractable: boolean;
  /**
   * A tenant's key, or a person's or a database's key a version of Bounda before tenant keys
   * wrapped under the master key directly, read once to be wrapped under the tenant's.
   */
  readonly kind: KeyKind;
}

export interface WrappedCryptoKey {
  readonly wrapped: Uint8Array;
  /**
   * The key that was wrapped, as one that cannot be exported.
   */
  readonly key: CryptoKey;
}

/**
 * A key wrapper as the runtime uses it: WebCrypto keys in and out, so a wrapper that WebCrypto
 * implements, as `masterKey`'s, never puts a raw key in JavaScript memory at all.
 */
export interface CryptoKeyWrapper {
  readonly kid: string;
  readonly previous: readonly string[];
  /**
   * `key`, a tenant's, must be exportable; what it resolves is kept as it is.
   */
  wrap(key: CryptoKey): Promise<WrappedCryptoKey>;
  unwrap(args: CryptoUnwrapArgs): Promise<CryptoKey>;
}

export interface BuildableKeyWrapperDefinition extends KeyWrapperDefinition {
  create(args: CreateKeyWrapperArgs): Promise<CryptoKeyWrapper>;
}

export interface DefineCryptoKeyWrapperFunction {
  (
    create: BuildableKeyWrapperDefinition["create"],
    options?: { readonly location?: string | undefined },
  ): KeyWrapperDefinition;
}

export const defineCryptoKeyWrapper: DefineCryptoKeyWrapperFunction = (
  create,
  { location } = {},
) => {
  const definition: BuildableKeyWrapperDefinition = {
    kind: "bounda-key-wrapper",
    create,
    ...(location === undefined ? {} : { location }),
  };
  return definition;
};

export interface CryptoKeyWrapperOverFunction {
  (wrapper: KeyWrapper): CryptoKeyWrapper;
}

export const cryptoKeyWrapperOver: CryptoKeyWrapperOverFunction = (wrapper) => ({
  kid: wrapper.kid,
  previous: wrapper.previous ?? [],
  wrap: (key) =>
    withRawKey(key, async (raw) => {
      // A copy: the bytes it resolves may be the very array it was given, which is zeroed next.
      const wrapped = Uint8Array.from(await wrapper.wrap(raw));
      return { wrapped, key: await importRawKey({ raw, extractable: false, kind: "tenant" }) };
    }),
  unwrap: async ({ kid, wrapped, extractable, kind }) => {
    const raw: unknown = await wrapper.unwrap({ kid, wrapped });
    if (!(raw instanceof Uint8Array)) {
      throw runtimeText(
        new ConfigurationError(
          `The key wrapper's unwrap resolved no Uint8Array for a key wrapped under ${kid}`,
        ),
      );
    }
    return importRawKey({ raw, extractable, kind });
  },
});

export interface DefineKeyWrapperFunction {
  (
    create: (args: CreateKeyWrapperArgs) => KeyWrapper | Promise<KeyWrapper>,
    options?: DataLocationOptions,
  ): KeyWrapperDefinition;
}

/**
 * A key wrapper of your own, such as one that asks a KMS, built from the host's environment when
 * the app starts. A `create` that throws fails the start. `location` declares where the KMS keeps
 * the master key: under a storage that declares one, the app refuses to start on a wrapper that
 * declares another, or none.
 */
export const defineKeyWrapper: DefineKeyWrapperFunction = (create, options) =>
  defineCryptoKeyWrapper(async (args) => cryptoKeyWrapperOver(await create(args)), options);

export interface IsKeyWrapperDefinitionFunction {
  (value: unknown): value is BuildableKeyWrapperDefinition;
}

export const isKeyWrapperDefinition: IsKeyWrapperDefinitionFunction = (
  value,
): value is BuildableKeyWrapperDefinition =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "bounda-key-wrapper" &&
  typeof Reflect.get(value, "create") === "function";

export interface BuildKeyWrapperArgs {
  readonly definition: KeyWrapperDefinition;
  readonly env: AppEnv;
}

export interface BuildKeyWrapperFunction {
  (args: BuildKeyWrapperArgs): Promise<CryptoKeyWrapper>;
}

export const buildKeyWrapper: BuildKeyWrapperFunction = async ({ definition, env }) => {
  if (!isKeyWrapperDefinition(definition)) {
    throw runtimeText(
      new ConfigurationError(
        'runtime.personalData.keyWrapper is not a key wrapper: build one with masterKey({ from: "BOUNDA_MASTER_KEY" }) or defineKeyWrapper',
      ),
    );
  }
  return definition.create({ env });
};
