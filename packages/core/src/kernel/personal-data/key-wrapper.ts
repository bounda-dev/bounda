import type { AppEnv } from "../../register/index.ts";

/**
 * Wraps the key of every person before the store keeps it, and unwraps it when the runtime reads
 * it, so a copy of the database holds no key that opens a personal field: envelope encryption.
 * `masterKey` is the one Bounda brings; a KMS, Vault or an HSM is an implementation of this
 * interface, given through `defineKeyWrapper`.
 *
 * The key a person's data is encrypted with never changes when it is wrapped anew, so rotating
 * the wrapping key rewrites no event.
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
   * Wraps the raw bytes of a person's key under `kid`. What it resolves is stored as it is.
   */
  wrap(key: Uint8Array): Promise<Uint8Array>;
  /**
   * Resolves the raw bytes `wrap` was given, for a key wrapped under `kid` or one of `previous`.
   * The runtime checks them against the key's fingerprint and refuses another key.
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
 * What `runtime.personalData.keyWrapper` holds: how to build the wrapper from the host's
 * environment when the app starts. Built by `masterKey` or `defineKeyWrapper`.
 */
export interface KeyWrapperDefinition {
  readonly kind: "bounda-key-wrapper";
  create(args: CreateKeyWrapperArgs): KeyWrapper | Promise<KeyWrapper>;
}

export interface DefineKeyWrapperFunction {
  (create: KeyWrapperDefinition["create"]): KeyWrapperDefinition;
}

/**
 * A key wrapper of your own, such as one that asks a KMS, built from the host's environment when
 * the app starts. A `create` that throws fails the start.
 */
export const defineKeyWrapper: DefineKeyWrapperFunction = (create) => ({
  kind: "bounda-key-wrapper",
  create,
});

export interface IsKeyWrapperDefinitionFunction {
  (value: unknown): value is KeyWrapperDefinition;
}

export const isKeyWrapperDefinition: IsKeyWrapperDefinitionFunction = (
  value,
): value is KeyWrapperDefinition =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "bounda-key-wrapper" &&
  typeof Reflect.get(value, "create") === "function";
