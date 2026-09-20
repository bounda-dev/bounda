/**
 * Identity and version the runtime adds to the state a command handler sees.
 */
export interface AggregateMeta {
  readonly id: string;
  readonly version: number;
}

/**
 * The optional `state.ts` module of an aggregate. `initialState` fixes the state type; declare
 * unions explicitly (`status: "new" as "new" | "paid"`). `aggregateId` names the payload field
 * that identifies the aggregate; it defaults to `<aggregate>Id`.
 */
export interface StateModule<State extends object = object> {
  readonly initialState: State;
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
