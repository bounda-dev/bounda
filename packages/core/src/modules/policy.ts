import type { CollaboratorImplementations } from "./command.ts";
import type { EmptyPayload } from "./payload.ts";

/**
 * The shape of a policy module. `on` overrides the event type derived from the file name and may
 * list several events.
 */
export interface PolicyModule {
  readonly handler: (args: never) => unknown;
  readonly on?: string | readonly string[];
}

/**
 * A policy in the registry: its module plus the collaborator implementations found next to it,
 * when the policy is a directory (`policies/<name>/index.ts`).
 */
export interface PolicyEntry {
  readonly module: PolicyModule;
  readonly collaborators?: CollaboratorImplementations;
}

/**
 * Arguments of a policy `handler`: the event that triggered it, the typed commands facade and the
 * policy's collaborators, spread at the top level.
 */
export type PolicyHandlerArgs<Event, Commands, Collaborators extends object = EmptyPayload> = {
  readonly event: Event;
  readonly commands: Commands;
  /**
   * A key to hand the providers this handler calls, so a retry does not repeat an effect: the
   * same on every automatic retry for this event, new when an operator replays a dead letter.
   */
  readonly idempotencyKey: string;
} & Readonly<Collaborators>;
