import type { DurationInput } from "../contracts/duration.ts";
import type { CollaboratorImplementations } from "./command.ts";
import type { EmptyPayload } from "./payload.ts";

/**
 * The shape of a policy module. `on` overrides the event type derived from the file name and may
 * list several events. `delay` runs the handler that long after the event was stored instead of
 * as soon as it is read.
 */
export interface PolicyModule {
  readonly handler: (args: never) => unknown;
  readonly on?: string | readonly string[];
  readonly delay?: DurationInput;
}

/**
 * A policy in the registry: its module, the collaborator implementations found next to it when
 * the policy is a directory (`policies/<name>/index.ts`), and the aggregate whose events it reacts
 * to when that is not the one it lives in (`policies/<aggregate>/...`).
 */
export interface PolicyEntry {
  readonly module: PolicyModule;
  readonly collaborators?: CollaboratorImplementations;
  readonly source?: string;
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
