import type { KeyedPerson, SealedValue } from "../../adapter/storage/personal-key-store.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import { type ErrorIdentity, errorDetails, errorIdentity } from "../shared/retry.ts";
import type { KeyOfFunction } from "./commands.ts";
import { createDisposableKey, isSealed, seal, unseal } from "./crypto.ts";
import { readUnder } from "./reads.ts";
import { type CategoryKey, inSealingOrder, type PersonalKeys } from "./wrapped-keys.ts";

export interface SealErrorArgs {
  readonly error: unknown;
  /**
   * Whose key the text is sealed under; with `null`, and no `statePerson`, it is kept in the
   * clear.
   */
  readonly person: string | null;
  /**
   * Whom the state of the process instance the work ran on names, when another than `person`:
   * the text is sealed under their keys too, around `person`'s.
   */
  readonly statePerson?: string | null;
  readonly keys: PersonalKeys;
  /**
   * What the failed work read of anyone besides what its unit of work noted on `error`, as the
   * event it ran on.
   */
  readonly read?: readonly KeyedPerson[];
}

/**
 * An error as a dead letter records it: its identity in the clear, its text sealed under the keys
 * of the person the failed work names.
 */
export interface SealedError extends ErrorIdentity {
  readonly errorMessage: string | SealedValue;
  readonly errorStack?: string | SealedValue;
}

export interface SealErrorFunction {
  (args: SealErrorArgs): Promise<SealedError>;
}

// The person holds no key, or not every key the work read their data under as it read it: they
// were forgotten since, and maybe keyed anew, or a forgetting kept a key read in force. A key no
// store keeps seals the text unreadable, as the forget would have, where a new or kept key would
// open what the work read before it.
const keysToSealWith = async (
  keys: PersonalKeys,
  person: string,
  readUnder: readonly KeyedPerson[],
): Promise<readonly CategoryKey[]> => {
  const held = await keys.heldAll(person);
  const holds = ({ fingerprint, retained }: KeyedPerson): boolean =>
    held.some(({ key }) => key.fingerprint === fingerprint && (!key.retained || retained === true));
  return held.length > 0 && readUnder.every(holds)
    ? inSealingOrder(held)
    : [
        {
          category: DEFAULT_PERSONAL_CATEGORY,
          key: await createDisposableKey(),
          retainedSince: null,
        },
      ];
};

export interface SealUnderAllFunction {
  (
    under: readonly CategoryKey[],
    person: string,
    value: string | SealedValue,
  ): Promise<SealedValue>;
}

/**
 * Text sealed under each key in turn, each sealing what the one before sealed, so it opens only
 * while the person holds every one of them.
 */
export const sealUnderAll: SealUnderAllFunction = async (under, person, value) => {
  let sealed: unknown = value;
  for (const { category, key } of under)
    sealed = await seal({ key, person, category, value: sealed });
  return sealed as SealedValue;
};

/**
 * Seals the message and the stack under every key the person holds, never creating one, and only
 * when the work read nothing of theirs under a key they no longer hold: a handler's error may quote
 * what it read of the person, in any category, so no store keeps its text in the clear once the
 * work names someone, and forgetting any category of theirs, as a forget that came meanwhile,
 * still reaches it.
 */
export const sealError: SealErrorFunction = async ({
  error,
  person,
  statePerson = null,
  keys,
  read = [],
}) => {
  const details = errorDetails(error);
  let errorMessage: string | SealedValue = details.message;
  let errorStack: string | SealedValue | undefined = details.stack;
  for (const one of new Set([person, statePerson])) {
    if (one === null) continue;
    const under = await keysToSealWith(keys, one, readUnder({ person: one, error, also: read }));
    errorMessage = await sealUnderAll(under, one, errorMessage);
    if (errorStack !== undefined) errorStack = await sealUnderAll(under, one, errorStack);
  }
  return {
    ...errorIdentity(error),
    errorMessage,
    ...(errorStack === undefined ? {} : { errorStack }),
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

/**
 * Opens text sealed under one key or under several, one inside the other, `null` as soon as one
 * of them is gone.
 */
export const openTextWith: OpenTextWithFunction = (keyOf) => {
  const open = async (value: string | SealedValue): Promise<string | null> => {
    if (typeof value === "string") return value;
    const opened = await unseal({
      key: await keyOf(value.$personal.person, value.$personal.key),
      sealed: value,
    });
    return isSealed(opened) ? open(opened) : (opened as string | null);
  };
  return open;
};
