import type { Command } from "../contracts/command.ts";
import type { DomainError } from "../contracts/errors.ts";
import type { HandlerState } from "./aggregate.ts";
import type { EventBuilders, EventModules } from "./event.ts";
import type { PayloadFunction } from "./payload.ts";

/**
 * The shape of a command module: an optional `payload` schema, the optional `rejections` it may
 * answer with and a `handler`.
 */
export interface CommandModule {
  readonly payload?: PayloadFunction;
  readonly rejections?: (args: never) => Readonly<Record<string, string>>;
  readonly handler: (args: never) => unknown;
}

/**
 * The codes a command module declares in `rejections`; `never` without it.
 */
export type RejectionCodeOf<Module> = Module extends {
  readonly rejections: (args: never) => infer Messages;
}
  ? Extract<keyof Messages, string>
  : never;

/**
 * Arguments of a command's `rejections`, which the runtime calls when the handler rejects: the
 * command and the state the handler saw, for the message to tell why.
 */
export interface CommandRejectionsArgs<Type extends string, Payload, State extends object> {
  readonly command: Command<Type, Payload>;
  readonly state: HandlerState<State>;
}

/**
 * Rejects the command with one of the codes its module declares, and the message `rejections`
 * gives it unless `message` is passed. `return reject(code)` and `throw reject(code)` do the same.
 */
export interface RejectFunction<Code extends string> {
  (code: Code, message?: string): DomainError<Code>;
}

/**
 * A command in the registry.
 */
export interface CommandEntry {
  readonly module: CommandModule;
}

/**
 * Arguments of a command `handler`. The aggregate's ports are spread at the top level so
 * a handler destructures them next to `command`, `state` and `events`.
 */
export type CommandHandlerArgs<
  Type extends string,
  Payload,
  State extends object,
  Events extends EventModules,
  Ports extends object,
  Rejected extends string = never,
> = {
  readonly command: Command<Type, Payload>;
  readonly state: HandlerState<State>;
  readonly events: EventBuilders<Events>;
  /**
   * The command's id, the same when a concurrency conflict runs the handler again: a key for a
   * call that must be safe to repeat, such as creating a payment intent.
   */
  readonly idempotencyKey: string;
  /**
   * Aborted when the handler runs out of time, when whoever dispatched the command withdraws it or
   * when the policy or process that dispatched it fails: pass it to what the handler calls outside
   * (`fetch(url, { signal })`) so it stops. Nothing the handler returns after that is stored.
   */
  readonly signal: AbortSignal;
} & ([Rejected] extends [never] ? unknown : { readonly reject: RejectFunction<Rejected> }) &
  Readonly<Ports>;
