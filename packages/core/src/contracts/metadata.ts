/**
 * Metadata carried by every stored event.
 *
 * `correlationId` groups everything caused by one external request.
 * `causationId` points at the command that produced the event.
 * `depth` counts how many reactive hops (policy → command → event) separate the event from the
 * original request; the runtime stops the chain when it exceeds the configured maximum.
 * `schemaVersion` is reserved for upcasting; it is `1` until a payload changes shape.
 * `system` marks events emitted by the runtime itself, such as process timeouts.
 */
export interface EventMetadata {
  readonly correlationId: string;
  readonly causationId: string;
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
