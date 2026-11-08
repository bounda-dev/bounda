import type { StorageTransaction } from "../../adapter/adapter.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { processOfStream } from "../process/lifecycle.ts";
import { digest } from "../read-model/fingerprint.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { createDisposableKey, isSealed, type PersonalKey, seal } from "./crypto.ts";
import type { PersonalMarks } from "./marks.ts";
import { lifecycleStateOf, sealState, statePersonOf } from "./process-state.ts";
import type { PersonalKeys } from "./wrapped-keys.ts";

export interface MarksFingerprintArgs {
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "all">;
}

export interface MarksFingerprintFunction {
  (args: MarksFingerprintArgs): string | null;
}

const entryOf = (name: string, marks: PersonalMarks | null): readonly string[] =>
  marks === null ? [] : [JSON.stringify([name, marks.person, [...marks.fields].sort()])];

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
 * Chooses, in the transaction that reseals, the key for what a record written in the clear holds
 * of a person, as the forget the record escaped would have left it.
 */
export interface ResealKeys {
  /**
   * For an event at `position`: a key no store keeps when a forgetting of the person came after
   * it, their key otherwise, created when they hold none.
   */
  event(person: string, position: number): Promise<ChosenKey>;
  /**
   * For a stored command's payload, filed at `at` for a dead letter: their key when they hold one
   * and were not forgotten after `at`, a new key when they hold none and were never forgotten,
   * and else a key no store keeps.
   */
  payload(person: string, at: string | null): Promise<ChosenKey>;
  /**
   * For the text of an error filed at `at`: their key when they hold one and were not forgotten
   * after `at`, and else a key no store keeps, never a new one, as a failure seals it.
   */
  errorText(person: string, at: string): Promise<ChosenKey>;
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
}

const cached = <Value>() => {
  const values = new Map<string, Promise<Value>>();
  return (person: string, read: () => Promise<Value>): Promise<Value> => {
    const known = values.get(person);
    if (known !== undefined) return known;
    const value = read();
    values.set(person, value);
    return value;
  };
};

// Each person's last forgetting, key and discarded key are read once per transaction, which a
// store whose transactions run one at a time keeps from changing while it runs.
export const createResealKeys: CreateResealKeysFunction = ({ transaction, keys }) => {
  const forgettings = cached<Forgetting | null>();
  const held = new Map<string, Promise<PersonalKey | null>>();
  const discarded = cached<PersonalKey>();

  const lastForgetting = (person: string): Promise<Forgetting | null> =>
    forgettings(person, async () => {
      const { events } = await transaction.eventStore.load({
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: person,
      });
      const last = events.findLast((event) => event.type === PERSONAL_DATA_FORGOTTEN_EVENT);
      return last === undefined ? null : { position: last.position, timestamp: last.timestamp };
    });

  const current = (person: string): Promise<PersonalKey | null> => {
    const known = held.get(person);
    if (known !== undefined) return known;
    const read = keys.held(person);
    held.set(person, read);
    return read;
  };

  const thrownAway = async (person: string): Promise<ChosenKey> => ({
    key: await discarded(person, createDisposableKey),
    discarded: true,
  });

  // The key in force, which the add answers, is the one the person holds from then on.
  const kept = async (person: string): Promise<ChosenKey> => {
    const key = await current(person);
    if (key !== null) return { key, discarded: false };
    const added = keys.create(person);
    held.set(person, added);
    return { key: await added, discarded: false };
  };

  return {
    event: async (person, position) => {
      const forgotten = await lastForgetting(person);
      return forgotten !== null && forgotten.position > position
        ? thrownAway(person)
        : kept(person);
    },
    payload: async (person, at) => {
      const [forgotten, key] = await Promise.all([lastForgetting(person), current(person)]);
      if (key === null) return forgotten === null ? kept(person) : thrownAway(person);
      return at !== null && forgotten !== null && forgotten.timestamp > at
        ? thrownAway(person)
        : { key, discarded: false };
    },
    errorText: async (person, at) => {
      const [forgotten, key] = await Promise.all([lastForgetting(person), current(person)]);
      return key === null || (forgotten !== null && forgotten.timestamp > at)
        ? thrownAway(person)
        : { key, discarded: false };
    },
  };
};

/**
 * What resealing one record takes: the person its marks name, and how its stored value reads once
 * what it holds of them in the clear is sealed under a key.
 */
export interface ResealPlan<Value> {
  readonly person: string;
  seal(key: PersonalKey): Promise<Value>;
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
  fields: readonly string[],
  person: string,
  key: PersonalKey,
): Promise<Record<string, unknown>> => {
  const sealed: Record<string, unknown> = { ...payload };
  for (const field of fields) {
    sealed[field] = await seal({ key, person, value: payload[field] });
  }
  return sealed;
};

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
  return { person, seal: (key) => sealFields(payload, clear, person, key) };
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
  clear: readonly string[],
  person: string | null,
  seal: (person: string, key: PersonalKey) => Promise<Value>,
): ResealPlanOf<Value> => {
  if (clear.length === 0 && event.person !== null) return null;
  if (person === null || (event.person !== null && event.person !== person)) {
    return clear.length === 0 ? null : "unsealable";
  }
  return { person, seal: (key) => seal(person, key) };
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
    return planned(event, clear, person, async (named, key) => ({
      ...(event.payload as object),
      state: await sealState({ marks, state, person: named, key: async () => key }),
    }));
  }
  const marks = aggregates.byName[event.aggregateType]?.eventsByType[event.type]?.personal ?? null;
  const { payload } = event;
  if (marks === null || !isRecord(payload)) return null;
  const clear = marks.fields.filter(
    (field) => payload[field] !== undefined && !isSealed(payload[field]),
  );
  const person = marks.person === null ? event.aggregateId : personIn(payload[marks.person]);
  return planned(event, clear, person, (named, key) => sealFields(payload, clear, named, key));
};
