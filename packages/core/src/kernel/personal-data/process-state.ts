import { ValidationError } from "../../contracts/errors.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { isSealed, type PersonalKey, seal } from "./crypto.ts";
import type { PersonalMarks } from "./marks.ts";

export interface LifecycleStateOfFunction {
  (payload: unknown): Readonly<Record<string, unknown>> | null;
}

/**
 * The state a process lifecycle event carries, where its marked fields sit; `null` for one that
 * carries none, as `ProcessCompleted`.
 */
export const lifecycleStateOf: LifecycleStateOfFunction = (payload) =>
  isRecord(payload) && isRecord(payload.state) ? payload.state : null;

export interface StatePersonOfArgs {
  readonly marks: PersonalMarks;
  readonly state: Readonly<Record<string, unknown>>;
  readonly instanceId: string;
}

export interface StatePersonOfFunction {
  (args: StatePersonOfArgs): string | null;
}

const holdsValue = (value: unknown): boolean => value !== undefined && value !== null;

export interface HoldsPersonalValueFunction {
  (marks: PersonalMarks, state: Readonly<Record<string, unknown>>): boolean;
}

export const holdsPersonalValue: HoldsPersonalValueFunction = (marks, state) =>
  marks.fields.some((field) => holdsValue(state[field]));

/**
 * Whom a process state names: its field marked `person()`, or, when it marks none, the instance's
 * id while a personal field holds a value. `null` while that field holds no id, since the person
 * is often learnt in a later step, or while the state holds nothing of the instance's person.
 */
export const statePersonOf: StatePersonOfFunction = ({ marks, state, instanceId }) => {
  if (marks.person === null) return holdsPersonalValue(marks, state) ? instanceId : null;
  const named = state[marks.person];
  if ((typeof named === "string" && named !== "") || typeof named === "number") {
    return String(named);
  }
  return null;
};

export interface CheckStatePersonArgs extends StatePersonOfArgs {
  readonly process: string;
}

export interface CheckStatePersonFunction {
  (args: CheckStatePersonArgs): void;
}

/**
 * Throws `ValidationError` when a personal field of the state holds a value and the state names
 * nobody to seal it under.
 */
export const checkStatePerson: CheckStatePersonFunction = (args) => {
  const { process, marks, state, instanceId } = args;
  if (marks.person === null || statePersonOf(args) !== null) return;
  if (!holdsPersonalValue(marks, state)) return;
  throw new ValidationError(
    `Process ${process} holds personal data for ${instanceId} and names no person in "${marks.person}"`,
    [{ path: [marks.person], message: "Expected a non-empty string" }],
  );
};

export interface SealStateArgs {
  readonly marks: PersonalMarks;
  readonly state: Readonly<Record<string, unknown>>;
  readonly person: string;
  readonly key: (person: string) => Promise<PersonalKey>;
}

export interface SealStateFunction {
  (args: SealStateArgs): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * The state with each personal field that holds a value sealed under the person's key. One that
 * holds `null` holds nothing of theirs and is kept, as is one sealed already, so a lifecycle event
 * written before its fields were marked can be sealed in place with what it still has in the
 * clear.
 */
export const sealState: SealStateFunction = async ({ marks, state, person, key }) => {
  const sealed: Record<string, unknown> = { ...state };
  for (const field of marks.fields) {
    const value = state[field];
    if (!holdsValue(value) || isSealed(value)) continue;
    sealed[field] = await seal({ key: await key(person), person, value });
  }
  return sealed;
};

export interface SealLifecycleEventArgs<Event extends LifecycleEvent> {
  readonly process: string;
  readonly marks: PersonalMarks;
  readonly event: Event;
  readonly key: (person: string) => Promise<PersonalKey>;
}

export interface LifecycleEvent {
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly person: string | null;
}

export interface SealLifecycleEventFunction {
  <Event extends LifecycleEvent>(args: SealLifecycleEventArgs<Event>): Promise<Event>;
}

/**
 * A lifecycle event as it is stored: the personal fields of its state sealed under the person the
 * state names, who becomes the event's `person`; as it is when it carries no state or the state
 * names nobody. Throws `ValidationError` for a personal value with nobody named.
 */
export const sealLifecycleEvent: SealLifecycleEventFunction = async ({
  process,
  marks,
  event,
  key,
}) => {
  const state = lifecycleStateOf(event.payload);
  if (state === null) return event;
  const named = { marks, state, instanceId: event.aggregateId };
  checkStatePerson({ ...named, process });
  const person = statePersonOf(named);
  if (person === null) return event;
  return {
    ...event,
    payload: {
      ...(event.payload as object),
      state: await sealState({ marks, state, person, key }),
    },
    person,
  };
};
