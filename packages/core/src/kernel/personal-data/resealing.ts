import type { StorageTransaction } from "../../adapter/adapter.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
} from "../../modules/bounda-events.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { processOfStream } from "../process/lifecycle.ts";
import { digest } from "../read-model/fingerprint.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { createDisposableKey, isSealed, type PersonalKey, seal } from "./crypto.ts";
import { fieldCategory, type PersonalMarks } from "./marks.ts";
import { lifecycleStateOf, sealState, statePersonOf } from "./process-state.ts";
import type { CategoryKey, PersonalKeys } from "./wrapped-keys.ts";

export interface MarksFingerprintArgs {
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "all">;
}

export interface MarksFingerprintFunction {
  (args: MarksFingerprintArgs): string | null;
}

const entryOf = (name: string, marks: PersonalMarks | null): readonly string[] =>
  marks === null
    ? []
    : [
        JSON.stringify([
          name,
          marks.person,
          // A field of the default category is named as it was before categories existed.
          [...marks.fields].sort().map((field) => {
            const category = fieldCategory(marks, field);
            return category === DEFAULT_PERSONAL_CATEGORY ? field : [field, category];
          }),
        ]),
      ];

/**
 * Names what every event, command and process state of the registry marks, so any change to a
 * mark names another set; `null` when nothing is marked.
 */
export const marksFingerprint: MarksFingerprintFunction = ({ aggregates, processes }) => {
  const marked: string[] = [];
  for (const aggregate of Object.values(aggregates.byName)) {
    for (const event of Object.values(aggregate.eventsByType)) {
      marked.push(...entryOf(`event:${aggregate.name}.${event.type}`, event.personal));
    }
    for (const command of Object.values(aggregate.commands)) {
      marked.push(...entryOf(`command:${aggregate.name}.${command.type}`, command.personal));
    }
  }
  for (const process of processes.all) {
    marked.push(...entryOf(`process:${process.name}`, process.personal));
  }
  return marked.length === 0 ? null : digest(JSON.stringify(marked.sort()));
};

/**
 * The key to seal a value written in the clear with, and whether no store keeps it: the person
 * was forgotten after the value was written, so it must read as forgotten.
 */
export interface ChosenKey {
  readonly key: PersonalKey;
  readonly discarded: boolean;
}

/**
 * The keys to seal the text of an error with, one inside the other, as a failure seals it.
 */
export interface ChosenKeys {
  readonly keys: readonly CategoryKey[];
  readonly discarded: boolean;
}

/**
 * Chooses, in the transaction that reseals, the key for what a record written in the clear holds
 * of a person, as the forget the record escaped would have left it.
 */
export interface ResealKeys {
  /**
   * For a value of `category` in an event at `position`: a key no store keeps when a forgetting
   * of that category of the person came after it, the key it retained when it retained the
   * category instead, while it lasts, and their key in force otherwise, created when they hold
   * none.
   */
  event(person: string, category: string, position: number): Promise<ChosenKey>;
  /**
   * For a value of `category` in a stored command's payload, filed at `at` for a dead letter:
   * their key in force when they hold one and that category was not forgotten after `at`, a new
   * key when they hold none and it was never forgotten, and else a key no store keeps.
   */
  payload(person: string, category: string, at: string | null): Promise<ChosenKey>;
  /**
   * For the text of an error filed at `at`: every key they hold when they hold one and nothing of
   * theirs was forgotten after `at`, and else a key no store keeps, never a new one, as a failure
   * seals it.
   */
  errorText(person: string, at: string): Promise<ChosenKeys>;
}

export interface CreateResealKeysArgs {
  /**
   * The store as written, in the transaction that reseals: forgettings are read from it.
   */
  readonly transaction: Pick<StorageTransaction, "eventStore">;
  /**
   * The transaction's keys as the kernel reads and writes them, unwrapped.
   */
  readonly keys: PersonalKeys;
}

export interface CreateResealKeysFunction {
  (args: CreateResealKeysArgs): ResealKeys;
}

interface Forgetting {
  readonly position: number;
  readonly timestamp: string;
  // `null` for one recorded before categories, which forgot every category.
  readonly payload: PersonalDataForgottenPayload | null;
}

// What a forgetting did to a category: forgot it, kept it, or nothing. An end of what an earlier
// one kept forgets only what that one kept, which the retention ends again on its own.
const coverOf = (forgetting: Forgetting, category: string): "forgot" | "retained" | null => {
  const { payload } = forgetting;
  if (payload === null || !Array.isArray(payload.categories)) return "forgot";
  const retained: readonly string[] = payload.retained;
  const forgot: readonly string[] = payload.categories;
  if (retained.includes(category)) return "retained";
  // A forgetting as a whole forgot every category it did not keep, one declared since included.
  return payload.whole !== false || forgot.includes(category) ? "forgot" : null;
};

const cached = <Value>() => {
  const values = new Map<string, Promise<Value>>();
  return (id: string, read: () => Promise<Value>): Promise<Value> => {
    const known = values.get(id);
    if (known !== undefined) return known;
    const value = read();
    values.set(id, value);
    return value;
  };
};

// Each person's forgettings, keys and discarded key are read once per transaction, which a store
// whose transactions run one at a time keeps from changing while it runs.
export const createResealKeys: CreateResealKeysFunction = ({ transaction, keys }) => {
  const forgettings = cached<readonly Forgetting[]>();
  const held = new Map<string, Promise<PersonalKey | null>>();
  const discarded = cached<PersonalKey>();

  const forgettingsOf = (person: string): Promise<readonly Forgetting[]> =>
    forgettings(person, async () => {
      const { events } = await transaction.eventStore.load({
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: person,
      });
      return events
        .filter((event) => event.type === PERSONAL_DATA_FORGOTTEN_EVENT)
        .map((event) => ({
          position: event.position,
          timestamp: event.timestamp,
          payload: isRecord(event.payload)
            ? (event.payload as unknown as PersonalDataForgottenPayload)
            : null,
        }));
    });

  // The last forgetting that forgot or kept the category, and what it did.
  const lastCovering = async (
    person: string,
    category: string,
  ): Promise<{ readonly forgetting: Forgetting; readonly cover: "forgot" | "retained" } | null> => {
    for (const forgetting of [...(await forgettingsOf(person))].reverse()) {
      const cover = coverOf(forgetting, category);
      if (cover !== null) return { forgetting, cover };
    }
    return null;
  };

  const current = (person: string, category: string): Promise<PersonalKey | null> => {
    const id = JSON.stringify([person, category]);
    const known = held.get(id);
    if (known !== undefined) return known;
    const read = keys.held(person, category);
    held.set(id, read);
    return read;
  };

  const thrownAway = async (person: string): Promise<ChosenKey> => ({
    key: await discarded(person, createDisposableKey),
    discarded: true,
  });

  // The key in force, which the add answers, is the one the person holds from then on.
  const kept = async (person: string, category: string): Promise<ChosenKey> => {
    const key = await current(person, category);
    if (key !== null) return { key, discarded: false };
    const added = keys.create(person, category);
    held.set(JSON.stringify([person, category]), added);
    return { key: await added, discarded: false };
  };

  // The key a forgetting kept for the category, while it lasts.
  const retainedBy = async (
    person: string,
    category: string,
    forgetting: Forgetting,
  ): Promise<ChosenKey> => {
    const [found] = (await keys.list(person))
      .filter(
        ({ category: of, retainedSince }) =>
          of === category && retainedSince !== null && retainedSince <= forgetting.timestamp,
      )
      .sort((a, b) => ((a.retainedSince ?? "") < (b.retainedSince ?? "") ? 1 : -1));
    if (found === undefined) return thrownAway(person);
    return { key: { ...(await keys.open(person, found.key)), retained: true }, discarded: false };
  };

  return {
    event: async (person, category, position) => {
      const last = await lastCovering(person, category);
      if (last === null || last.forgetting.position < position) return kept(person, category);
      return last.cover === "retained"
        ? retainedBy(person, category, last.forgetting)
        : thrownAway(person);
    },
    payload: async (person, category, at) => {
      const [last, key] = await Promise.all([
        lastCovering(person, category),
        current(person, category),
      ]);
      if (key === null) return last === null ? kept(person, category) : thrownAway(person);
      return at !== null && last !== null && last.forgetting.timestamp > at
        ? thrownAway(person)
        : { key, discarded: false };
    },
    errorText: async (person, at) => {
      const [all, every] = await Promise.all([forgettingsOf(person), keys.heldAll(person)]);
      const since = all.some(
        (forgetting) =>
          forgetting.timestamp > at &&
          (forgetting.payload === null ||
            !Array.isArray(forgetting.payload.categories) ||
            forgetting.payload.categories.length + forgetting.payload.retained.length > 0),
      );
      if (every.length > 0 && !since) {
        return {
          keys: [...every].sort((a, b) =>
            a.category === b.category
              ? a.key.fingerprint < b.key.fingerprint
                ? -1
                : 1
              : a.category < b.category
                ? -1
                : 1,
          ),
          discarded: false,
        };
      }
      const { key } = await thrownAway(person);
      return { keys: [{ category: DEFAULT_PERSONAL_CATEGORY, key }], discarded: true };
    },
  };
};

/**
 * What resealing one record takes: the person its marks name, the categories of the values it
 * holds in the clear, and how its stored value reads once they are sealed, each under the key
 * chosen for its category.
 */
export interface ResealPlan<Value> {
  readonly person: string;
  readonly categories: readonly string[];
  seal(keyOf: (category: string) => PersonalKey): Promise<Value>;
}

/**
 * `null` for a record with nothing to reseal; `unsealable` for one holding personal values in the
 * clear that names no person to seal them under, or another person than the one it was sealed
 * for.
 */
export type ResealPlanOf<Value> = ResealPlan<Value> | "unsealable" | null;

const personIn = (value: unknown): string | null =>
  (typeof value === "string" && value !== "") || typeof value === "number" ? String(value) : null;

const sealFields = async (
  payload: Readonly<Record<string, unknown>>,
  marks: PersonalMarks,
  fields: readonly string[],
  person: string,
  keyOf: (category: string) => PersonalKey,
): Promise<Record<string, unknown>> => {
  const sealed: Record<string, unknown> = { ...payload };
  for (const field of fields) {
    const category = fieldCategory(marks, field);
    sealed[field] = await seal({ key: keyOf(category), person, category, value: payload[field] });
  }
  return sealed;
};

const categoriesOf = (marks: PersonalMarks, fields: readonly string[]): readonly string[] => [
  ...new Set(fields.map((field) => fieldCategory(marks, field))),
];

export interface PlanPayloadResealArgs {
  readonly marks: PersonalMarks | null;
  readonly payload: unknown;
  /**
   * The id of the aggregate, which names the person when the marks name no field.
   */
  readonly aggregateId: string;
}

export interface PlanPayloadResealFunction {
  (args: PlanPayloadResealArgs): ResealPlanOf<Record<string, unknown>>;
}

/**
 * For a command's payload, as a scheduled command or a dead letter holds it: its marked fields
 * that hold a value in the clear, sealed as `sealCommandPayload` seals them.
 */
export const planPayloadReseal: PlanPayloadResealFunction = ({ marks, payload, aggregateId }) => {
  if (marks === null || !isRecord(payload)) return null;
  const clear = marks.fields.filter(
    (field) => payload[field] !== undefined && !isSealed(payload[field]),
  );
  if (clear.length === 0) return null;
  const person = marks.person === null ? aggregateId : personIn(payload[marks.person]);
  if (person === null) return "unsealable";
  return {
    person,
    categories: categoriesOf(marks, clear),
    seal: (keyOf) => sealFields(payload, marks, clear, person, keyOf),
  };
};

export interface PlanEventResealArgs {
  readonly event: StoredEvent;
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
}

export interface PlanEventResealFunction {
  (args: PlanEventResealArgs): ResealPlanOf<unknown>;
}

const holdsValue = (value: unknown): boolean => value !== undefined && value !== null;

// Clear values with nobody to seal them under, or under another person than the event names, are
// left as they are; an event with none is left alone whatever it names.
const planned = <Value>(
  event: StoredEvent,
  marks: PersonalMarks,
  clear: readonly string[],
  person: string | null,
  seal: (person: string, keyOf: (category: string) => PersonalKey) => Promise<Value>,
): ResealPlanOf<Value> => {
  if (clear.length === 0 && event.person !== null) return null;
  if (person === null || (event.person !== null && event.person !== person)) {
    return clear.length === 0 ? null : "unsealable";
  }
  return { person, categories: categoriesOf(marks, clear), seal: (keyOf) => seal(person, keyOf) };
};

/**
 * For an event as the store holds it: the marked fields of a domain event's payload, or of the
 * state a process lifecycle event carries, that hold a value in the clear, sealed as the event
 * store seals them as it appends, and the person the marks name, whom the event then names too.
 * An event with no value in the clear that names nobody yet gets its person all the same.
 */
export const planEventReseal: PlanEventResealFunction = ({ event, aggregates, processes }) => {
  const process = processOfStream(event.aggregateType);
  if (process !== null) {
    const marks = processes.byName[process]?.personal ?? null;
    const state = lifecycleStateOf(event.payload);
    if (marks === null || state === null) return null;
    const clear = marks.fields.filter(
      (field) => holdsValue(state[field]) && !isSealed(state[field]),
    );
    const person = statePersonOf({ marks, state, instanceId: event.aggregateId });
    return planned(event, marks, clear, person, async (named, keyOf) => ({
      ...(event.payload as object),
      state: await sealState({
        marks,
        state,
        person: named,
        key: async (_person, category) => keyOf(category),
      }),
    }));
  }
  const marks = aggregates.byName[event.aggregateType]?.eventsByType[event.type]?.personal ?? null;
  const { payload } = event;
  if (marks === null || !isRecord(payload)) return null;
  const clear = marks.fields.filter(
    (field) => payload[field] !== undefined && !isSealed(payload[field]),
  );
  const person = marks.person === null ? event.aggregateId : personIn(payload[marks.person]);
  return planned(event, marks, clear, person, (named, keyOf) =>
    sealFields(payload, marks, clear, named, keyOf),
  );
};
