import type { PersonalKeyStore, SealedValue } from "../../adapter/storage/personal-key-store.ts";
import { type ErrorIdentity, errorDetails, errorIdentity } from "../shared/retry.ts";
import type { KeyOfFunction } from "./commands.ts";
import {
  generatePersonalKey,
  importPersonalKey,
  type PersonalKey,
  seal,
  unseal,
} from "./crypto.ts";

export interface SealErrorArgs {
  readonly error: unknown;
  /**
   * Whose key the text is sealed under; with `null` it is kept in the clear.
   */
  readonly person: string | null;
  readonly keys: PersonalKeyStore;
}

/**
 * An error as a dead letter records it: its identity in the clear, its text sealed under the
 * person the failed work names.
 */
export interface SealedError extends ErrorIdentity {
  readonly errorMessage: string | SealedValue;
  readonly errorStack?: string | SealedValue;
}

export interface SealErrorFunction {
  (args: SealErrorArgs): Promise<SealedError>;
}

// The work read the person's data, so they held a key then: none now means they were forgotten
// since. A key no store keeps seals the text unreadable, as the forget would have.
const keyToSealWith = async (keys: PersonalKeyStore, person: string): Promise<PersonalKey> =>
  importPersonalKey((await keys.get(person)) ?? (await generatePersonalKey()));

/**
 * Seals the message and the stack with the key the person holds, never creating one: a handler's
 * error may quote what it read of the person, so no store keeps its text in the clear once the
 * work names someone, and a forget that came meanwhile still reaches it.
 */
export const sealError: SealErrorFunction = async ({ error, person, keys }) => {
  const details = errorDetails(error);
  const identity = errorIdentity(error);
  if (person === null) {
    return {
      ...identity,
      errorMessage: details.message,
      ...(details.stack === undefined ? {} : { errorStack: details.stack }),
    };
  }
  const key = await keyToSealWith(keys, person);
  return {
    ...identity,
    errorMessage: await seal({ key, person, value: details.message }),
    ...(details.stack === undefined
      ? {}
      : { errorStack: await seal({ key, person, value: details.stack }) }),
  };
};

export interface OpenTextFunction {
  /**
   * Text as it was sealed, or as it is when it was kept in the clear; `null` once the person it
   * was sealed under was forgotten.
   */
  (value: string | SealedValue): Promise<string | null>;
}

export interface OpenTextWithFunction {
  (keyOf: KeyOfFunction): OpenTextFunction;
}

export const openTextWith: OpenTextWithFunction = (keyOf) => async (value) =>
  typeof value === "string"
    ? value
    : ((await unseal({
        key: await keyOf(value.$personal.person, value.$personal.key),
        sealed: value,
      })) as string | null);
