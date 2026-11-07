import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import { fromBase64, toBase64 } from "./crypto.ts";
import { defineKeyWrapper, type KeyWrapper, type KeyWrapperDefinition } from "./key-wrapper.ts";

/**
 * What prints a master key in the encoding `masterKey` reads: 32 random bytes in base64.
 */
export const GENERATE_MASTER_KEY_COMMAND = "openssl rand -base64 32";

// 32 bytes are 43 base64 characters and one `=`.
const MASTER_KEY = /^[A-Za-z0-9+/]{43}=$/;

const KID_BYTES = 12;

export interface MasterKeyOptions {
  /**
   * The name of the environment variable that holds the master key, never the key itself.
   */
  readonly from: string;
  /**
   * The names of the variables that hold master keys used before, which still unwrap what they
   * wrapped until the worker has rewrapped it under `from`'s.
   */
  readonly previous?: readonly string[];
}

export interface MasterKeyFunction {
  (options: MasterKeyOptions): KeyWrapperDefinition;
}

const read = (env: AppEnv, name: string): string => {
  const value: unknown = Reflect.get(env, name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(
      `The environment variable ${name}, which runtime.personalData.keyWrapper names as a master key, is not set. Generate one with: ${GENERATE_MASTER_KEY_COMMAND}`,
    );
  }
  const text = value.trim();
  if (!MASTER_KEY.test(text)) {
    throw new ConfigurationError(
      `The environment variable ${name} does not hold a master key: it must be 32 random bytes in base64, 44 characters. Generate one with: ${GENERATE_MASTER_KEY_COMMAND}`,
    );
  }
  return text;
};

interface MasterKey {
  readonly kid: string;
  readonly key: CryptoKey;
}

// `KID_BYTES` is a multiple of three, so there is no padding to strip.
const base64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_");

// The id is part of the key's SHA-256: it tells keys apart and reveals nothing of a random one.
const importMasterKey = async (text: string): Promise<MasterKey> => {
  const raw = fromBase64(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return {
    kid: base64Url(digest.slice(0, KID_BYTES)),
    key: await crypto.subtle.importKey("raw", raw, "AES-KW", false, ["wrapKey", "unwrapKey"]),
  };
};

/**
 * The key wrapper Bounda brings: AES-KW under a master key read from the host's environment when
 * the app starts, `process.env` in Node, the Worker's secrets in a Durable Object. The variable
 * holds 32 random bytes in base64, as `openssl rand -base64 32` prints them. A variable that is
 * missing or holds anything else fails the start with `ConfigurationError`, naming the variable,
 * never its value. Each key's id is derived from the key, so a wrong master key is told apart
 * from the right one, and rotating takes only moving the old variable to `previous`.
 */
export const masterKey: MasterKeyFunction = ({ from, previous = [] }) =>
  defineKeyWrapper(async ({ env }): Promise<KeyWrapper> => {
    const current = await importMasterKey(read(env, from));
    const older = (
      await Promise.all(previous.map((name) => importMasterKey(read(env, name))))
    ).filter(({ kid }) => kid !== current.kid);
    const byKid = new Map([current, ...older].map((key) => [key.kid, key.key]));
    return {
      kid: current.kid,
      previous: [...new Set(older.map(({ kid }) => kid))],
      wrap: async (key) => {
        const personal = await crypto.subtle.importKey(
          "raw",
          Uint8Array.from(key),
          "AES-GCM",
          true,
          ["encrypt"],
        );
        return new Uint8Array(await crypto.subtle.wrapKey("raw", personal, current.key, "AES-KW"));
      },
      unwrap: async ({ kid, wrapped }) => {
        const wrapping = byKid.get(kid);
        if (wrapping === undefined) {
          throw new ConfigurationError(`No master key configured has the id ${kid}`);
        }
        let personal: CryptoKey;
        try {
          personal = await crypto.subtle.unwrapKey(
            "raw",
            Uint8Array.from(wrapped),
            wrapping,
            "AES-KW",
            "AES-GCM",
            true,
            ["encrypt"],
          );
        } catch (error) {
          throw new ConfigurationError(
            `A personal key does not unwrap under the master key ${kid}: the key was altered in the store`,
            { cause: error },
          );
        }
        return new Uint8Array(await crypto.subtle.exportKey("raw", personal));
      },
    };
  });
