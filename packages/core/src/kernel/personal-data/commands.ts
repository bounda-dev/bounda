import type { KeyedPerson, PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { isRecord } from "../shared/merge-fields.ts";
import {
  generatePersonalKey,
  importPersonalKey,
  isSealed,
  type PersonalKey,
  seal,
  unseal,
} from "./crypto.ts";
import type { PersonalMarks } from "./marks.ts";

export interface SealCommandPayloadArgs {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly marks: PersonalMarks | null;
  readonly keys: PersonalKeyStore;
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

const keyInForce = async (keys: PersonalKeyStore, person: string): Promise<PersonalKey> =>
  importPersonalKey(
    (await keys.get(person)) ?? (await keys.add(person, await generatePersonalKey())),
  );

/**
 * Seals the payload's personal fields with the key of the person the command names, created on
 * their first sealed field. A key removed before the payload is stored leaves it sealed under a key
 * no one holds: the command then never runs, as `openCommandPayload` tells.
 */
export const sealCommandPayload: SealCommandPayloadFunction = async (args) => {
  const { payload, marks, keys } = args;
  if (marks === null || !isRecord(payload)) return { payload, persons: [] };
  const present = marks.fields.filter((field) => payload[field] !== undefined);
  if (present.length === 0) return { payload, persons: [] };
  const person = personOf(args, payload, marks.person);
  const key = await keyInForce(keys, person);
  const sealed: Record<string, unknown> = { ...payload };
  for (const field of present) {
    sealed[field] = await seal({ key, person, value: payload[field] });
  }
  return { payload: sealed, persons: [{ person, fingerprint: key.fingerprint }] };
};

export interface OpenCommandPayloadArgs {
  readonly payload: unknown;
  readonly keys: PersonalKeyStore;
}

/**
 * A stored payload with its sealed fields opened. `forgotten` when one of them no longer opens,
 * its person forgotten since: the field reads as `null`, and the command must not run.
 */
export interface OpenedPayload {
  readonly payload: unknown;
  readonly forgotten: boolean;
}

export interface OpenCommandPayloadFunction {
  (args: OpenCommandPayloadArgs): Promise<OpenedPayload>;
}

/**
 * Opens whatever the payload holds sealed, whether or not the command still marks the field, so a
 * payload stored before its marks changed reads as it was written; one stored before they existed
 * holds nothing sealed and comes back as it is.
 */
export const openCommandPayload: OpenCommandPayloadFunction = async ({ payload, keys }) => {
  if (!isRecord(payload)) return { payload, forgotten: false };
  const opened: Record<string, unknown> = { ...payload };
  // Each person's key read and imported once, whatever number of their fields the payload seals.
  const imported = new Map<string, Promise<PersonalKey | null>>();
  const keyOf = (person: string, fingerprint: string): Promise<PersonalKey | null> => {
    const id = `${person}\u0000${fingerprint}`;
    const known = imported.get(id);
    if (known !== undefined) return known;
    const key = keys
      .get(person)
      .then((stored) =>
        stored === null || stored.fingerprint !== fingerprint ? null : importPersonalKey(stored),
      );
    imported.set(id, key);
    return key;
  };
  let forgotten = false;
  for (const [field, value] of Object.entries(payload)) {
    if (!isSealed(value)) continue;
    const key = await keyOf(value.$personal.person, value.$personal.key);
    if (key === null) forgotten = true;
    opened[field] = await unseal({ key, sealed: value });
  }
  return { payload: opened, forgotten };
};
