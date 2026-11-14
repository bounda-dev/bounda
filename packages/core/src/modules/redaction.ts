import type { AppRegistry } from "../register/index.ts";
import type { TypeNameOf } from "./naming.ts";
import type { PersonalPayloadFieldsOf, PersonalStateFieldsOf } from "./personal.ts";
import type { Registry } from "./registry.ts";

/**
 * The lifecycle events of a process that carry its state, whose personal fields `redact` reaches.
 */
export type ProcessStateEventType =
  | "ProcessStarted"
  | "ProcessHandled"
  | "ProcessDeadlineReached"
  | "ProcessTimedOut";

/**
 * Every lifecycle event that carries a process's state, in the order of `ProcessStateEventType`.
 */
export const PROCESS_STATE_EVENT_TYPES: readonly ProcessStateEventType[] = [
  "ProcessStarted",
  "ProcessHandled",
  "ProcessDeadlineReached",
  "ProcessTimedOut",
];

/**
 * One event `redact` reaches: the event as the person's export lists it, by its stream, type and
 * id, and the fields marked `personal` to seal for good, those of its payload, or of the state a
 * process's lifecycle event carries.
 */
export interface RedactedFields<
  AggregateType extends string = string,
  Type extends string = string,
  Field extends string = string,
> {
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly type: Type;
  readonly id: string;
  readonly fields: readonly Field[];
}

type EventTargetsOf<Aggregate extends string, Events> = {
  [Key in keyof Events & string]: [PersonalPayloadFieldsOf<Events[Key]>] extends [never]
    ? never
    : RedactedFields<Aggregate, TypeNameOf<Key>, PersonalPayloadFieldsOf<Events[Key]>>;
}[keyof Events & string];

type ProcessTargetsOf<Aggregate extends string, Processes> = {
  [Key in keyof Processes & string]: Processes[Key] extends { readonly module: infer Module }
    ? [PersonalStateFieldsOf<Module>] extends [never]
      ? never
      : RedactedFields<
          `process:${Aggregate}.${Key}`,
          ProcessStateEventType,
          PersonalStateFieldsOf<Module>
        >
    : never;
}[keyof Processes & string];

/**
 * What `redact` takes of one event of the registry `R`: for each event type with personal fields,
 * its aggregate, its type and the fields it marks; for each process whose state marks fields, its
 * stream and the lifecycle events that carry the state. Any event and field names for the untyped
 * `Registry`.
 */
export type RedactionTarget<R extends Registry = AppRegistry> = Registry extends R
  ? RedactedFields
  : {
      [Aggregate in keyof R["aggregates"] & string]:
        | EventTargetsOf<Aggregate, R["aggregates"][Aggregate]["events"]>
        | ProcessTargetsOf<Aggregate, R["aggregates"][Aggregate]["processes"]>;
    }[keyof R["aggregates"] & string];

/**
 * What `redact(personId, options)` takes besides the person.
 */
export interface RedactOptions<R extends Registry = AppRegistry> {
  /**
   * The events whose fields hold a value of the person that is wrong, each with the fields to
   * seal: every one must name the person.
   */
  readonly events: readonly RedactionTarget<R>[];
}
