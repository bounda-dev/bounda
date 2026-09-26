import type { LooseDurationInput } from "../contracts/duration.ts";
import type { CollaboratorImplementations } from "./command.ts";
import type { EmptyPayload, InferPayload, PayloadArgs } from "./payload.ts";

/**
 * What a process `config` returns. Event names are the PascalCase type names of the aggregate's
 * events; a typo does not compile.
 */
export interface ProcessConfig<EventName extends string = string> {
  readonly startedBy: readonly EventName[];
  readonly completedBy?: readonly EventName[];
  readonly timeout?: LooseDurationInput;
}

/**
 * Arguments of a process `config`: the event names of the aggregate, as `events.OrderPlaced`.
 */
export interface ProcessConfigArgs<EventName extends string> {
  readonly events: { readonly [Name in EventName]: Name };
}

/**
 * Arguments of a process `state` schema function.
 */
export type ProcessStateArgs = PayloadArgs;

/**
 * The shape of a process `index.ts`: a `config` and an optional `state` schema.
 */
export interface ProcessModule {
  readonly config: (args: never) => ProcessConfig;
  readonly state?: (args: PayloadArgs) => unknown;
}

/**
 * The shape of an `on-<event>.ts` or `on-timeout.ts` handler module.
 */
export interface ProcessHandlerModule {
  readonly handler: (args: never) => unknown;
}

/**
 * A process in the registry: its module, one handler module per event it reacts to, keyed by the
 * event's camelCase name, the optional timeout handler and the collaborator implementations found
 * in its directory, which every handler of the process receives.
 */
export interface ProcessEntry {
  readonly module: ProcessModule;
  readonly handlers: Readonly<Record<string, ProcessHandlerModule>>;
  readonly timeout?: ProcessHandlerModule;
  readonly collaborators?: CollaboratorImplementations;
}

/**
 * The state type of a process: inferred from its `state` schema, empty when absent.
 */
export type ProcessStateOf<Module> = Module extends { readonly state: infer F }
  ? InferPayload<F>
  : EmptyPayload;

/**
 * Arguments of an `on-<event>.ts` handler, with the process's collaborators spread at the top
 * level. The handler returns the new process state.
 */
export type ProcessHandlerArgs<
  Event,
  State,
  Commands,
  Collaborators extends object = EmptyPayload,
> = {
  readonly event: Event;
  readonly state: Readonly<State>;
  readonly aggregateId: string;
  readonly commands: Commands;
  /**
   * A key to hand the providers this handler calls, so a retry does not repeat an effect: the
   * same on every automatic retry for this event, new when an operator replays a dead letter.
   */
  readonly idempotencyKey: string;
} & Readonly<Collaborators>;

/**
 * Arguments of an `on-timeout.ts` handler, with the process's collaborators spread at the top
 * level. The handler returns the new process state.
 */
export type ProcessTimeoutArgs<State, Commands, Collaborators extends object = EmptyPayload> = {
  readonly state: Readonly<State>;
  readonly aggregateId: string;
  readonly commands: Commands;
  /**
   * A key to hand the providers this handler calls: the same on every retry of this time-out, new
   * when an operator replays it from the dead letters.
   */
  readonly idempotencyKey: string;
} & Readonly<Collaborators>;
