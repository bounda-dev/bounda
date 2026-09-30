import type { Command } from "../contracts/command.ts";
import type { HandlerState } from "./aggregate.ts";
import type { EventBuilders, EventModules } from "./event.ts";
import type { PayloadFunction } from "./payload.ts";

/**
 * The shape of a command module: an optional `payload` schema and a `handler`.
 */
export interface CommandModule {
  readonly payload?: PayloadFunction;
  readonly handler: (args: never) => unknown;
}

/**
 * A command in the registry.
 */
export interface CommandEntry {
  readonly module: CommandModule;
}

/**
 * Arguments of a command `handler`. The aggregate's collaborators are spread at the top level so
 * a handler destructures them next to `command`, `state` and `events`.
 */
export type CommandHandlerArgs<
  Type extends string,
  Payload,
  State extends object,
  Events extends EventModules,
  Collaborators extends object,
> = {
  readonly command: Command<Type, Payload>;
  readonly state: HandlerState<State>;
  readonly events: EventBuilders<Events>;
  /**
   * The command's id, the same when a concurrency conflict runs the handler again: a key for a
   * call that must be safe to repeat, such as creating a payment intent.
   */
  readonly idempotencyKey: string;
} & Readonly<Collaborators>;
