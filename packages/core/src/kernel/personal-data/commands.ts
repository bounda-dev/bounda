import { type KeyedPerson, keyedPersonId } from "../../adapter/storage/personal-key-store.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { isSealed, type PersonalKey, refuseSealed, seal, unseal } from "./crypto.ts";
import { fieldCategory, type PersonalMarks } from "./marks.ts";
import type { PersonalKeys } from "./wrapped-keys.ts";

export interface SealCommandPayloadArgs {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly marks: PersonalMarks | null;
  readonly keys: PersonalKeys;
}

/**
 * A payload as it is stored, with the people whose fields it holds sealed, each with the key.
 */
export interface SealedPayload {
  readonly payload: unknown;
  readonly persons: readonly KeyedPerson[];
}

export interface SealCommandPayloadFunction {
  (args: SealCommandPayloadArgs): Promise<SealedPayload>;
}

const personOf = (
  { type, aggregateId }: SealCommandPayloadArgs,
  payload: Record<string, unknown>,
  field: string | null,
): string => {
  if (field === null) return aggregateId;
  const value = payload[field];
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    throw new ValidationError(`Command ${type} names no person in "${field}"`, [
      { path: [field], message: "Expected a non-empty string" },
    ]);
  }
  return String(value);
};

const keyInForce = async (
  keys: PersonalKeys,
  person: string,
  category: string,
): Promise<PersonalKey> =>
  (await keys.held(person, category)) ?? (await keys.create(person, category));

export interface KeyOfFunction {
  (person: string, fingerprint: string): Promise<PersonalKey | null>;
}

export interface SealedKeysFunction {
  (keys: PersonalKeys): KeyOfFunction;
}

/**
 * Reads the key a value was sealed under, `null` once the person no longer holds it: each key
 * read and imported once, whatever number of values it opens.
 */
export const sealedKeys: SealedKeysFunction = (keys) => {
  const imported = new Map<string, Promise<PersonalKey | null>>();
  return (person, fingerprint) => {
    const id = keyedPersonId({ person, fingerprint });
    const known = imported.get(id);
    if (known !== undefined) return known;
    const key = keys.opened(person, fingerprint);
    imported.set(id, key);
    return key;
  };
};

/**
 * Seals the payload's personal fields with the person's key of each field's category, the person
 * the command names, created on their first sealed field. A key removed before the payload is
 * stored leaves it sealed under a key no one holds: the command then never runs, as
 * `openCommandPayload` tells.
 */
export const sealCommandPayload: SealCommandPayloadFunction = async (args) => {
  const { payload, marks, keys } = args;
  if (!isRecord(payload)) return { payload, persons: [] };
  refuseSealed({ payload, subject: `Command ${args.type}`, writer: "caller" });
  if (marks === null) return { payload, persons: [] };
  const present = marks.fields.filter((field) => payload[field] !== undefined);
  if (present.length === 0) return { payload, persons: [] };
  const person = personOf(args, payload, marks.person);
  const sealed: Record<string, unknown> = { ...payload };
  const persons = new Map<string, KeyedPerson>();
  for (const field of present) {
    const category = fieldCategory(marks, field);
    const key = await keyInForce(keys, person, category);
    persons.set(key.fingerprint, { person, fingerprint: key.fingerprint });
    sealed[field] = await seal({ key, person, category, value: payload[field] });
  }
  return { payload: sealed, persons: [...persons.values()] };
};

export interface OpenCommandPayloadArgs {
  readonly payload: unknown;
  readonly keys: PersonalKeys;
  /**
   * Keys already read, shared with what else the caller opens; read from `keys` otherwise.
   */
  readonly keyOf?: KeyOfFunction;
}

/**
 * A stored payload with its sealed fields opened. `forgotten` when one of them no longer opens,
 * its person forgotten since: the field reads as `null`, and the command must not run.
 */
export interface OpenedPayload {
  readonly payload: unknown;
  readonly forgotten: boolean;
  /**
   * Each person whose sealed fields opened, with the key that opened them.
   */
  readonly opened: readonly KeyedPerson[];
}

export interface OpenCommandPayloadFunction {
  (args: OpenCommandPayloadArgs): Promise<OpenedPayload>;
}

/**
 * Opens whatever the payload holds sealed, whether or not the command still marks the field, so a
 * payload stored before its marks changed reads as it was written; one stored before they existed
 * holds nothing sealed and comes back as it is.
 */
export const openCommandPayload: OpenCommandPayloadFunction = async ({
  payload,
  keys,
  keyOf = sealedKeys(keys),
}) => {
  if (!isRecord(payload)) return { payload, forgotten: false, opened: [] };
  const unsealed: Record<string, unknown> = { ...payload };
  const opened = new Map<string, KeyedPerson>();
  let forgotten = false;
  for (const [field, value] of Object.entries(payload)) {
    if (!isSealed(value)) continue;
    const { person } = value.$personal;
    const key = await keyOf(person, value.$personal.key);
    if (key === null) forgotten = true;
    else {
      const held: KeyedPerson = key.retained
        ? { person, fingerprint: key.fingerprint, retained: true }
        : { person, fingerprint: key.fingerprint };
      opened.set(keyedPersonId(held), held);
    }
    unsealed[field] = await unseal({ key, sealed: value });
  }
  return { payload: unsealed, forgotten, opened: [...opened.values()] };
};
