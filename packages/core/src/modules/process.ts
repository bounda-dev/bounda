import type { z } from "zod";
import type { DurationInput, LooseDurationInput } from "../contracts/duration.ts";
import type { Instant, instantSchema } from "../contracts/instant.ts";
import type { EventModules, EventTypeNames, StoredEventOf } from "./event.ts";
import type { TypeNameOf } from "./naming.ts";
import type { EmptyPayload, PayloadArgs } from "./payload.ts";

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
 * The schema `instant()` returns: a moment the process only records, `null` until it is set.
 */
export type InstantFieldSchema = z.ZodDefault<z.ZodNullable<typeof instantSchema>>;

/**
 * The schema `deadline()` returns: a moment the process acts at, `null` while nothing is due. It
 * only counts as a deadline as a field of the state object, as `deadline()` returned it.
 */
export type DeadlineFieldSchema = InstantFieldSchema & { readonly "~deadline": true };

/**
 * Arguments of a process `state` schema function. `deadline()` declares a moment the process acts
 * at: setting it to `after("24h")` in a handler schedules its `at-<field>.ts`, changing it moves
 * it and `null` cancels it. `instant()` declares a moment it only records.
 */
export interface ProcessStateArgs extends PayloadArgs {
  readonly deadline: () => DeadlineFieldSchema;
  readonly instant: () => InstantFieldSchema;
}

/**
 * The deadline fields of a process module: the fields of its `state` declared with `deadline()`.
 */
export type ProcessDeadlineFields<Module> = Module extends {
  readonly state: (args: never) => { readonly shape: infer Shape };
}
  ? {
      readonly [Key in keyof Shape]: Shape[Key] extends { readonly "~deadline": true }
        ? Key
        : never;
    }[keyof Shape] &
      string
  : never;

/**
 * A deadline field of a process module by name. A name that is not a `deadline()` of its `state`
 * does not compile: what the `+types` of an `at-<field>.ts` checks its file name with.
 */
export type ProcessDeadlineField<Module, Field extends ProcessDeadlineFields<Module>> = Field;

/**
 * A moment some time after what triggered the handler: the event's time in an `on-<event>.ts`,
 * the deadline that came due in an `at-<field>.ts`. So a retry, or a handler that runs late,
 * schedules the same moment.
 */
export interface ProcessAfterFunction {
  (delay: DurationInput): Instant;
}

/**
 * The shape of a process `index.ts`: a `config`, an optional `state` schema and, when it listens
 * to other aggregates, `correlate`.
 */
export interface ProcessModule {
  readonly config: (args: never) => ProcessConfig;
  readonly state?: (args: ProcessStateArgs) => unknown;
  readonly correlate?: Readonly<
    Record<string, Readonly<Record<string, ((event: never) => string | null) | undefined>>>
  >;
}

/**
 * The shape of an `on-<event>.ts` or `at-<deadline>.ts` handler module.
 */
export interface ProcessHandlerModule {
  readonly handler: (args: never) => unknown;
}

/**
 * A process in the registry. `handlers` are grouped by the event's aggregate and keyed by its
 * camelCase name (`handlers.payment.paymentFailed`); `deadlines` are keyed by field, with
 * `timeout` for `at-timeout.ts`.
 */
export interface ProcessEntry {
  readonly module: ProcessModule;
  readonly handlers: Readonly<Record<string, Readonly<Record<string, ProcessHandlerModule>>>>;
  readonly deadlines?: Readonly<Record<string, ProcessHandlerModule>>;
}

/**
 * The state type of a process: inferred from its `state` schema, empty when absent.
 */
export type ProcessStateOf<Module> = Module extends {
  readonly state: (args: never) => infer Schema;
}
  ? Schema extends z.ZodType
    ? z.output<Schema>
    : never
  : EmptyPayload;

/**
 * What a process handler may return: the next state, which the `state` schema parses so missing
 * fields take their defaults, or nothing to keep the state as it is.
 */
export type ProcessHandlerResult<State> = Readonly<Partial<State>> | undefined | void;

/**
 * What the `+types` of every process handler asserts as `ReturnCheck`, so a handler that returns a
 * plain string for a deadline, or a field of the wrong type, does not compile. Not for app code.
 */
export type ProcessHandlerReturnCheck<
  State,
  Module extends {
    readonly handler: (
      args: never,
    ) => ProcessHandlerResult<State> | Promise<ProcessHandlerResult<State>>;
  },
> = Module;

/**
 * Arguments of an `on-<event>.ts` handler, with the aggregate's collaborators spread at the top
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
  /**
   * Aborted when the handler runs out of time or its run fails: pass it to what the handler calls
   * outside (`fetch(url, { signal })`) so it stops. Its commands still running stop too, and
   * those dispatched after that are refused, both with `REACTION_ABANDONED`.
   */
  readonly signal: AbortSignal;
  /**
   * A moment some time after the event: `nextReminder: after("24h")` schedules a deadline.
   */
  readonly after: ProcessAfterFunction;
} & Readonly<Collaborators>;

/**
 * Arguments of an `at-<field>.ts` handler, with the aggregate's collaborators spread at the top
 * level: `state` holds the deadline that came due as `Field`. The handler returns the new process
 * state, with the field set to `null` or another moment: leaving it at the one that came due fails
 * the process. For `at-timeout.ts`, `Field` is `never` and the process ends as `timed_out`
 * whatever it returns.
 */
export type ProcessDeadlineArgs<
  State,
  Field extends keyof State,
  Commands,
  Collaborators extends object = EmptyPayload,
> = {
  readonly state: Readonly<State & { readonly [Key in Field]: Instant }>;
  readonly aggregateId: string;
  readonly commands: Commands;
  /**
   * A key to hand the providers this handler calls: the same on every retry of this deadline at
   * this moment, new when an operator replays it from the dead letters.
   */
  readonly idempotencyKey: string;
  /**
   * Aborted when the handler runs out of time or its run fails: pass it to what the handler calls
   * outside (`fetch(url, { signal })`) so it stops. Its commands still running stop too, and
   * those dispatched after that are refused, both with `REACTION_ABANDONED`.
   */
  readonly signal: AbortSignal;
  /**
   * A moment some time after the deadline that came due: `nextReminder: after("24h")` repeats it
   * every day, without drifting when a run is late.
   */
  readonly after: ProcessAfterFunction;
} & Readonly<Collaborators>;
