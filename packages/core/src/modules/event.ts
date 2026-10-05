import type { NewEvent, StoredEvent } from "../contracts/event.ts";
import type { TypeNameOf } from "./naming.ts";
import { capitalize } from "./naming.ts";
import type { HasPayload, PayloadFunction, PayloadOf } from "./payload.ts";

/**
 * The shape of an event module: an optional `payload` schema and `create`, `apply` or both. Each
 * returns the state fields the event sets, merged shallowly over the state. `create` opens the
 * aggregate, from the event alone; `apply` folds a later event into the state.
 */
export interface EventModule {
  readonly payload?: PayloadFunction;
  readonly create?: (args: never) => object;
  readonly apply?: (args: never) => object;
}

/**
 * The events of one aggregate, keyed by their camelCase name.
 */
export type EventModules = Readonly<Record<string, EventModule>>;

/**
 * Arguments of `apply`. When one of the aggregate's events exports `create`, `apply` only ever
 * runs on an aggregate that exists, so `state` has every field `create` always sets.
 */
export interface EventApplyArgs<State extends object, Type extends string, Payload> {
  readonly state: Readonly<State>;
  readonly event: StoredEvent<Type, Payload>;
}

/**
 * Arguments of `create`: the event alone, since the aggregate has no state before it.
 */
export interface EventCreateArgs<Type extends string, Payload> {
  readonly event: StoredEvent<Type, Payload>;
}

/**
 * The event type names of an aggregate as a literal union: `"OrderPlaced" | "OrderPaid"`.
 */
export type EventTypeNames<Events extends EventModules> = TypeNameOf<keyof Events>;

/**
 * The new event produced by one event module.
 */
export type EventOf<Events extends EventModules, Key extends keyof Events> = NewEvent<
  TypeNameOf<Key>,
  PayloadOf<Events[Key]>
>;

/**
 * The stored event of one event module, as policies, processes and projections receive it.
 */
export type StoredEventOf<Events extends EventModules, Key extends keyof Events> = StoredEvent<
  TypeNameOf<Key>,
  PayloadOf<Events[Key]>
>;

/**
 * Any new event of an aggregate.
 */
export type EventUnion<Events extends EventModules> = {
  [Key in keyof Events]: EventOf<Events, Key>;
}[keyof Events];

/**
 * Any stored event of an aggregate.
 */
export type StoredEventUnion<Events extends EventModules> = {
  [Key in keyof Events]: StoredEventOf<Events, Key>;
}[keyof Events];

/**
 * The `events` object a command handler receives: one builder per event of its own aggregate.
 * Events with a payload take it as argument; events without take none.
 */
export type EventBuilders<Events extends EventModules> = {
  readonly [Key in keyof Events]: HasPayload<Events[Key]> extends true
    ? (payload: PayloadOf<Events[Key]>) => EventOf<Events, Key>
    : () => EventOf<Events, Key>;
};

export type CreateEventBuildersFunction = <Events extends EventModules>(
  events: Events,
) => EventBuilders<Events>;

/**
 * Builds the `events` object for an aggregate from its event modules. Payloads are validated
 * later, when the command pipeline persists the events.
 */
export const createEventBuilders: CreateEventBuildersFunction = <Events extends EventModules>(
  events: Events,
) => {
  const entries = Object.keys(events).map((key) => {
    const type = capitalize(key);
    const build = (payload: unknown = {}): NewEvent => ({ type, payload });
    return [key, build] as const;
  });
  return Object.fromEntries(entries) as EventBuilders<Events>;
};
