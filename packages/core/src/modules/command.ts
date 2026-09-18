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
 * Implementations of one command's collaborators, keyed by collaborator name and then by
 * implementation name (the `<name>.<implementation>.ts` file suffix).
 */
export type CollaboratorImplementations = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/**
 * The collaborator types a command handler receives when the module does not declare a
 * `Collaborators` type: the type of the implementations found next to it.
 */
export type InferCollaborators<Implementations extends CollaboratorImplementations> = {
  readonly [Name in keyof Implementations]: Implementations[Name][keyof Implementations[Name]];
};

/**
 * A command in the registry: its module plus the collaborator implementations found next to it.
 */
export interface CommandEntry {
  readonly module: CommandModule;
  readonly collaborators?: CollaboratorImplementations;
}

/**
 * Arguments of a command `handler`. Collaborators are spread at the top level so a handler
 * destructures them next to `command`, `state` and `events`.
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
} & Readonly<Collaborators>;
