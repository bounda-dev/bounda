import type { RestrictionBasis } from "../modules/personal-data.ts";
import { ValidationError } from "./errors.ts";

/**
 * The longest actor a client takes in `as`, as long as an idempotency key.
 */
export const MAX_ACTOR_LENGTH: number = 255;

export interface CheckActorFunction {
  (actor: unknown): asserts actor is string;
}

/**
 * Throws `ValidationError` unless `actor` is an actor `as` takes: a string of 1 to
 * `MAX_ACTOR_LENGTH` characters. For a host that hands the actor on before a client binds it.
 */
export const checkActor: CheckActorFunction = (actor) => {
  if (typeof actor === "string" && actor.length > 0 && actor.length <= MAX_ACTOR_LENGTH) return;
  throw new ValidationError("as needs the id of who acts", [
    { path: ["actor"], message: `Expected a string of 1 to ${MAX_ACTOR_LENGTH} characters` },
  ]);
};

/**
 * Metadata carried by every stored event.
 *
 * `correlationId` groups everything caused by one external request.
 * `causationId` is what caused the command that wrote the event: the event a policy or a process
 * reacted to, or the command itself when it came from outside. So an event leads to the event
 * that caused it, though commands are not stored.
 * `commandId` is the command that wrote the event. Events the runtime writes itself have none,
 * and point their causation at what made it write them, usually the event it handled.
 * `actor` is who acted: the id the host named with `as` on the call that caused the event, kept
 * by the policies, processes and scheduled commands that follow from it, and by the events the
 * runtime writes for them, such as a process's lifecycle events. Absent when that call named
 * nobody, and when nobody called, such as forgetting after a retention.
 * `depth` counts how many reactive hops (policy → command → event) separate the event from the
 * original request; the runtime stops the chain when it exceeds `maxChainDepth`.
 * `schemaVersion` is the shape the payload was written in: one more than the number of upcasts
 * its event type declared when it was written. An event read through its upcasts carries the current one.
 * `system` marks events emitted by the runtime itself, such as process timeouts.
 */
export interface EventMetadata {
  readonly correlationId: string;
  readonly causationId: string;
  readonly commandId?: string;
  readonly actor?: string;
  /**
   * The basis the command that wrote the event processed restricted data on, from
   * `processRestricted`; absent when it named none.
   */
  readonly restrictionBasis?: RestrictionBasis;
  readonly depth: number;
  readonly schemaVersion: number;
  readonly system: boolean;
}

/**
 * Metadata attached to a command when it enters the runtime. `actor` is who acts, as
 * `EventMetadata` describes it; every event the command writes carries it.
 */
export interface CommandMetadata {
  readonly commandId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly actor?: string;
  /**
   * The basis it processes restricted data on, from `processRestricted`; absent when it names none.
   */
  readonly restrictionBasis?: RestrictionBasis;
  readonly depth: number;
  readonly timestamp: string;
}

/**
 * The causal context that travels through a reactive chain. Policies and processes dispatch
 * commands with the context of the event they are reacting to, so correlation and actor are
 * preserved end to end without ambient state.
 */
export interface CausationContext {
  readonly correlationId: string;
  readonly causationId: string;
  readonly actor?: string;
  readonly depth: number;
}
