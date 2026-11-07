import type { StoredEvent } from "../../contracts/event.ts";
import type { CausationContext } from "../../contracts/metadata.ts";

export interface ActedByFunction {
  (actor: string | undefined): { readonly actor?: string };
}

// No key rather than `undefined`, so metadata without an actor reads the same once stored as JSON.
export const actedBy: ActedByFunction = (actor) => (actor === undefined ? {} : { actor });

export interface StartedByFunction {
  (correlationId: string, actor: string | undefined): CausationContext;
}

/**
 * The context of a call from outside the runtime, which starts its own chain.
 */
export const startedBy: StartedByFunction = (correlationId, actor) => ({
  correlationId,
  causationId: correlationId,
  depth: 0,
  ...actedBy(actor),
});

export interface CausedByFunction {
  (event: StoredEvent): CausationContext;
}

/**
 * The context of what reacts to the event: under its correlation and actor, caused by it, at its
 * depth.
 */
export const causedBy: CausedByFunction = (event) => ({
  correlationId: event.metadata.correlationId,
  causationId: event.id,
  depth: event.metadata.depth,
  ...actedBy(event.metadata.actor),
});
