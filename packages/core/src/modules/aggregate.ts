/**
 * Identity and version the runtime adds to the state a command handler sees.
 */
export interface AggregateMeta {
  readonly id: string;
  readonly version: number;
}

export interface StateModule<State extends object = object> {
  readonly initialState: State;
  // The payload field that identifies the aggregate.
  readonly aggregateId?: string;
}

/**
 * The state type declared by a state module.
 */
export type StateOf<Module> = Module extends { readonly initialState: infer State extends object }
  ? State
  : never;

/**
 * The state a command handler receives: the aggregate state plus identity and version.
 */
export type HandlerState<State extends object> = Readonly<State> & AggregateMeta;

/**
 * The state of an aggregate whose shape the generator could not determine: no `state.ts` and no
 * inference result. Every field is unknown; add a `state.ts` with `initialState` to fix it.
 */
export type UnknownState = Record<string, unknown>;

/**
 * The state of an aggregate that does not exist yet, when one of its events opens it with
 * `begin`: every field of the created state, `undefined`. A command handler tells the two apart
 * by any field `begin` always sets, so `state.status === undefined` means "not created".
 */
export type NotCreated<State extends object> = { readonly [Key in keyof State]?: undefined };
