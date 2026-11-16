import type { DispatchOutcome, StoredAnswer } from "../../adapter/storage/idempotency-store.ts";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type KeyedPerson,
  keyedPersonId,
} from "../../adapter/storage/personal-key-store.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { type AtRestSealer, isSealedAtRest } from "./at-rest.ts";
import { sealedKeys } from "./commands.ts";
import { isSealed, seal, unseal } from "./crypto.ts";
import { isEarlierAnswer } from "./earlier-answers.ts";
import { fieldCategory, type PersonalMarks } from "./marks.ts";
import { type CategoryKey, inSealingOrder, type PersonalKeys } from "./wrapped-keys.ts";

// `key` is the caller's. `marks` is the fingerprint of the marks it was sealed under, `null` in an
// app that marks nothing; absent from one sealed before answers named theirs.
export interface RememberedAnswer {
  readonly key: string;
  readonly fingerprint: string;
  readonly outcome: DispatchOutcome;
  readonly marks?: string | null;
}

export interface AnswerSealing {
  readonly keys: PersonalKeys;
  // `null` in an app without keys, which keeps every answer in the clear: none holds anything
  // personal.
  readonly atRest: AtRestSealer | null;
}

export interface SealAnswerArgs extends AnswerSealing {
  readonly answer: RememberedAnswer;
  // Whom the command touches.
  readonly person: string | null;
  // The person gets a key of every category the payload holds a value of, so forgetting that
  // category reaches what the answer quotes of it.
  readonly marks: PersonalMarks | null;
  readonly payload: unknown;
  // Whose data the state a rejection was decided on held, each with the key it was read under.
  readonly read: readonly KeyedPerson[];
}

// `answer` is `null` when a key the state was read under is gone: erased before it is written.
export interface SealedAnswer {
  readonly answer: StoredAnswer | null;
  readonly persons: readonly KeyedPerson[];
}

export interface SealAnswerFunction {
  (args: SealAnswerArgs): Promise<SealedAnswer>;
}

const categoriesOf = (marks: PersonalMarks | null, payload: unknown): readonly string[] =>
  marks === null || !isRecord(payload)
    ? []
    : marks.fields
        .filter((field) => payload[field] !== undefined && payload[field] !== null)
        .map((field) => fieldCategory(marks, field));

// Every key the person holds in force, and one of each category in `categories`, created when they
// hold none; `default` when that leaves none. `null` when a key the state was read under is not in
// force: the store keeps no answer under a key a forgetting kept, nor under one that is gone.
const layersOf = async (
  keys: PersonalKeys,
  person: string,
  read: readonly KeyedPerson[],
  categories: readonly string[],
): Promise<readonly CategoryKey[] | null> => {
  const held = await keys.heldAll(person);
  const layers = new Map<string, CategoryKey>();
  for (const key of held) {
    if (key.retainedSince === null) layers.set(key.key.fingerprint, key);
  }
  if (read.some(({ fingerprint }) => fingerprint !== null && !layers.has(fingerprint))) return null;
  const inForce = new Set([...layers.values()].map((key) => key.category));
  const wanted = [...new Set(categories)].filter((category) => !inForce.has(category));
  if (layers.size === 0 && wanted.length === 0) wanted.push(DEFAULT_PERSONAL_CATEGORY);
  for (const category of wanted) {
    const key = await keys.create(person, category);
    layers.set(key.fingerprint, { category, key, retainedSince: null });
  }
  return inSealingOrder([...layers.values()]);
};

// One layer per key, one inside the other, so it opens only while each is in force: forgetting
// any category of anyone it names leaves it unreadable without finding it.
export const sealAnswer: SealAnswerFunction = async ({
  keys,
  atRest,
  answer,
  person,
  marks,
  payload,
  read,
}) => {
  if (atRest === null) return { answer: { ...answer }, persons: [] };
  const persons = [
    ...new Set([...(person === null ? [] : [person]), ...read.map((r) => r.person)]),
  ];
  const named = new Map<string, KeyedPerson>();
  let sealed: unknown = answer;
  for (const one of persons.sort()) {
    const layers = await layersOf(
      keys,
      one,
      read.filter((held) => held.person === one),
      one === person ? categoriesOf(marks, payload) : [],
    );
    if (layers === null) return { answer: null, persons: [] };
    for (const { category, key } of layers) {
      sealed = await seal({ key, person: one, category, value: sealed });
      named.set(keyedPersonId({ person: one, fingerprint: key.fingerprint }), {
        person: one,
        fingerprint: key.fingerprint,
      });
    }
  }
  if (named.size > 0) return { answer: sealed as StoredAnswer, persons: [...named.values()] };
  return { answer: await atRest.seal(JSON.stringify(answer)), persons: [] };
};

export interface OpenAnswerArgs extends AnswerSealing {
  readonly answer: StoredAnswer;
}

export interface OpenAnswerFunction {
  (args: OpenAnswerArgs): Promise<RememberedAnswer | null>;
}

// `null` once a key it was sealed under is gone. An app with keys keeps no answer in the clear:
// one is from before answers were sealed, and is no answer.
export const openAnswer: OpenAnswerFunction = async ({ keys, atRest, answer }) => {
  if (atRest !== null && isEarlierAnswer(answer)) return null;
  let opened: unknown = answer;
  const keyOf = sealedKeys(keys);
  while (isSealed(opened)) {
    const { person, key } = opened.$personal;
    opened = await unseal({ key: await keyOf(person, key), sealed: opened });
    if (opened === null) return null;
  }
  if (!isSealedAtRest(opened)) return opened as RememberedAnswer;
  if (atRest === null) return null;
  return JSON.parse(await atRest.open(opened)) as RememberedAnswer;
};
