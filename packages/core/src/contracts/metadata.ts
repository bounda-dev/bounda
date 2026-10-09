/**
 * Metadata carried by every stored event.
 *
 * `correlationId` groups everything caused by one external request.
 * `causationId` is what caused the command that wrote the event: the event a policy or a process
 * reacted to, or the command itself when it came from outside. So an event leads to the event
 * that caused it, though commands are not stored.
 * `commandId` is the command that wrote the event. Events the runtime writes itself have none,
 * and point their causation at what made it write them, usually the event it handled.
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
  readonly depth: number;
  readonly schemaVersion: number;
  readonly system: boolean;
}

/**
 * Metadata attached to a command when it enters the runtime.
 */
export interface CommandMetadata {
  readonly commandId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly depth: number;
  readonly timestamp: string;
}

/**
 * The causal context that travels through a reactive chain. Policies and processes dispatch
 * commands with the context of the event they are reacting to, so correlation is preserved
 * end to end without ambient state.
 */
export interface CausationContext {
  readonly correlationId: string;
  readonly causationId: string;
  readonly depth: number;
}
