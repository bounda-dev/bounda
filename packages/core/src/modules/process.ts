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
 * Which instance of a process an event belongs to, as `from.<aggregate>.<Event>(…)` makes it.
 */
export interface ProcessCorrelation {
  readonly event: string;
  readonly correlate: (event: never) => string | null;
}

/**
 * Arguments of a process `correlate`: `from.payment.PaymentFailed((event) => …)` says which
 * instance an event belongs to, from the event to the id of the process's own aggregate, or
 * `null` to ignore it; `correlate` returns one for each event it decides. An event of another
 * aggregate whose payload declares the id field of the process's aggregate (`orderId`) needs none:
 * it belongs to the instance that field names, and to none when it is `null`. The process's own
 * events find their instance by their `aggregateId`.
 */
export interface ProcessCorrelateArgs<Events extends AppEventModules> {
  readonly from: {
    readonly [Aggregate in keyof Events & string]: {
      readonly [Key in keyof Events[Aggregate] & string as TypeNameOf<Key>]: (
        correlate: (event: StoredEventOf<Events[Aggregate], Key>) => string | null,
      ) => ProcessCorrelation;
    };
  };
}

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

export interface ProcessModule {
  readonly config: (args: never) => ProcessConfig;
  readonly state?: (args: ProcessStateArgs) => unknown;
  readonly correlate?: (args: never) => readonly ProcessCorrelation[];
}

export interface ProcessHandlerModule {
  readonly handler: (args: never) => unknown;
}

export interface ProcessEntry {
  readonly module: ProcessModule;
  // By the event's aggregate, then its camelCase name: `handlers.payment.paymentFailed`.
  readonly handlers: Readonly<Record<string, Readonly<Record<string, ProcessHandlerModule>>>>;
  // By field, with `timeout` for `at-timeout.ts`.
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
 * What a process handler may return: the fields that change, merged over the state, or nothing to
 * keep the state as it is. The merge is shallow, so a nested object is replaced whole; a field
 * goes back to its default only when the handler sets it to that, and keeps its value when
 * returned as `undefined`.
 */
export type ProcessHandlerResult<State> = Readonly<Partial<State>> | undefined | void;

/**
 * What an `at-<field>.ts` handler returns: the fields that change, merged over the state as
 * {@link ProcessHandlerResult} is, always with `Field` set to `null` or to its next moment.
 */
export type ProcessDeadlineResult<State, Field extends keyof State> = Readonly<
  Partial<State> & { readonly [Key in Field]: Instant | null }
>;

// A field the state does not declare would be dropped by the schema without a word, so a key the
// handler returns beyond the state's must be `never`: the error then names it. With no such key it
// is `unknown`, since intersecting with `{}` would let a string through `Partial<State>`.
type UndeclaredFields<Keys extends PropertyKey> = [Keys] extends [never]
  ? unknown
  : { readonly [Key in Keys]?: never };

type ReturnOf<State, Field extends keyof State, Undeclared extends PropertyKey> = [Field] extends [
  never,
]
  ? (Readonly<Partial<State>> & UndeclaredFields<Undeclared>) | undefined | void
  : ProcessDeadlineResult<State, Field> & UndeclaredFields<Undeclared>;

type KeysOf<Result> = Result extends object ? keyof Result : never;

type ReturnedKeys<Module> = Module extends { readonly handler: (args: never) => infer Returned }
  ? KeysOf<Awaited<Returned>>
  : never;

/**
 * What the `+types` of every process handler asserts as `ReturnCheck`, so a handler that returns a
 * plain string for a deadline, a field of the wrong type or one the state does not declare does
 * not compile; nor an `at-<field>.ts` handler that leaves out its `Field`. Not for app code.
 */
export type ProcessHandlerReturnCheck<
  State,
  Module extends {
    readonly handler: (
      args: never,
    ) => ReturnOf<State, Field, Undeclared> | Promise<ReturnOf<State, Field, Undeclared>>;
  },
  Field extends keyof State = never,
  Undeclared extends PropertyKey = Exclude<ReturnedKeys<Module>, keyof State>,
> = Module;

/**
 * Arguments of an `on-<event>.ts` handler, with the aggregate's ports spread at the top
 * level. The handler returns the fields of the process state that change.
 */
export type ProcessHandlerArgs<Event, State, Commands, Ports extends object = EmptyPayload> = {
  readonly event: Event;
  readonly state: Readonly<State>;
  readonly aggregateId: string;
  readonly commands: Commands;
  /**
   * A key to hand the providers this handler calls, so a retry does not repeat an effect: the
   * same on every automatic retry for this event, new when an operator retries a dead letter.
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
} & Readonly<Ports>;

/**
 * Arguments of an `at-<field>.ts` handler, with the aggregate's ports spread at the top
 * level: `state` holds the deadline that came due as `Field`. The handler returns the fields of
 * the process state that change, `Field` among them: `null` or another moment, since keeping the
 * one that came due fails the process. For
 * `at-timeout.ts`, `Field` is `never` and the process ends as `timed_out` whatever it returns; the
 * events its commands cause still reach the process's handlers.
 */
export type ProcessDeadlineArgs<
  State,
  Field extends keyof State,
  Commands,
  Ports extends object = EmptyPayload,
> = {
  readonly state: Readonly<State & { readonly [Key in Field]: Instant }>;
  readonly aggregateId: string;
  readonly commands: Commands;
  /**
   * A key to hand the providers this handler calls: the same on every automatic retry of this
   * deadline at this moment, new when an operator retries it from the dead letters.
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
} & Readonly<Ports>;
