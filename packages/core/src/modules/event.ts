import type { NewEvent, StoredEvent } from "../contracts/event.ts";
import type { TypeNameOf } from "./naming.ts";
import { capitalize } from "./naming.ts";
import type { HasPayload, PayloadFunction, PayloadInputOf, PayloadOf } from "./payload.ts";

export interface EventModule {
  readonly payload?: PayloadFunction;
  readonly begin?: (args: never) => object;
  readonly evolve?: (args: never) => object;
}

// Keyed by the event's camelCase name.
export type EventModules = Readonly<Record<string, EventModule>>;

/**
 * Arguments of `evolve`. When one of the aggregate's events exports `begin`, `evolve` only ever
 * runs on an aggregate that exists, so `state` has every field `begin` always sets.
 */
export interface EventEvolveArgs<State extends object, Type extends string, Payload> {
  readonly state: Readonly<State>;
  readonly event: StoredEvent<Type, Payload>;
}

/**
 * Arguments of `begin`: the event alone, since the aggregate has no state before it.
 */
export interface EventBeginArgs<Type extends string, Payload> {
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
 * Events with a payload take what their schema takes as input, which the command pipeline
 * validates when it stores the event; events without take none.
 */
export type EventBuilders<Events extends EventModules> = {
  readonly [Key in keyof Events]: HasPayload<Events[Key]> extends true
    ? (
        payload: PayloadInputOf<Events[Key]>,
      ) => NewEvent<TypeNameOf<Key>, PayloadInputOf<Events[Key]>>
    : () => EventOf<Events, Key>;
};

export type CreateEventBuildersFunction = <Events extends EventModules>(
  events: Events,
) => EventBuilders<Events>;

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
