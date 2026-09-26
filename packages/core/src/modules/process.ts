import type { LooseDurationInput } from "../contracts/duration.ts";
import type { CollaboratorImplementations } from "./command.ts";
import type { EventModules, EventTypeNames, StoredEventOf } from "./event.ts";
import type { TypeNameOf } from "./naming.ts";
import type { EmptyPayload, InferPayload, PayloadArgs } from "./payload.ts";

/**
 * The event modules of every aggregate of the app, keyed by aggregate.
 */
export type AppEventModules = Readonly<Record<string, EventModules>>;

/**
 * Every event of the app by its qualified name, `order.OrderPlaced`.
 */
export type QualifiedEventName<Events extends AppEventModules> = {
  readonly [Aggregate in keyof Events &
    string]: `${Aggregate}.${EventTypeNames<Events[Aggregate]>}`;
}[keyof Events & string];

/**
 * What a process `config` returns. Events are named by aggregate and type,
 * `events.payment.PaymentFailed`; a typo does not compile.
 */
export interface ProcessConfig<EventName extends string = string> {
  readonly startedBy: readonly EventName[];
  readonly completedBy?: readonly EventName[];
  readonly timeout?: LooseDurationInput;
}

/**
 * Arguments of a process `config`: every event of the app by aggregate, as
 * `events.order.OrderPlaced`, whose value is the qualified name `"order.OrderPlaced"`.
 */
export interface ProcessConfigArgs<Events extends AppEventModules> {
  readonly events: {
    readonly [Aggregate in keyof Events & string]: {
      readonly [Name in EventTypeNames<Events[Aggregate]>]: `${Aggregate}.${Name}`;
    };
  };
}

/**
 * How the events of other aggregates find their process instance: per aggregate and event type,
 * a function from the event to the id of the process's own aggregate, or `null` to ignore it.
 * `{ payment: { PaymentFailed: (event) => event.payload.orderId } }`. The process's own events
 * find their instance by their `aggregateId` unless an entry says otherwise.
 */
export type ProcessCorrelate<Events extends AppEventModules> = {
  readonly [Aggregate in keyof Events & string]?: {
    readonly [Key in keyof Events[Aggregate] & string as TypeNameOf<Key>]?: (
      event: StoredEventOf<Events[Aggregate], Key>,
    ) => string | null;
  };
};

/**
 * Arguments of a process `state` schema function.
 */
export type ProcessStateArgs = PayloadArgs;

/**
 * The shape of a process `index.ts`: a `config`, an optional `state` schema and, when it listens
 * to other aggregates, `correlate`.
 */
export interface ProcessModule {
  readonly config: (args: never) => ProcessConfig;
  readonly state?: (args: PayloadArgs) => unknown;
  readonly correlate?: Readonly<
    Record<string, Readonly<Record<string, ((event: never) => string | null) | undefined>>>
  >;
}

/**
 * The shape of an `on-<event>.ts` or `on-timeout.ts` handler module.
 */
export interface ProcessHandlerModule {
  readonly handler: (args: never) => unknown;
}

/**
 * A process in the registry: its module, one handler module per event it reacts to, grouped by
 * the event's aggregate and keyed by its camelCase name (`handlers.payment.paymentFailed`), the
 * optional timeout handler and the collaborator implementations found in its directory, which
 * every handler of the process receives.
 */
export interface ProcessEntry {
  readonly module: ProcessModule;
  readonly handlers: Readonly<Record<string, Readonly<Record<string, ProcessHandlerModule>>>>;
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
