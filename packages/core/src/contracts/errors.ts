/**
 * Base class for every error thrown by Bounda. `code` is stable across versions and safe to
 * branch on; `message` is for humans.
 */
export class BoundaError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Thrown by user code to say a rule of the domain forbids what was asked. From a command handler
 * it rejects the command: the runtime returns it to the caller as is and does not retry it. Where
 * there is no caller to return it to, it is terminal: out of a policy or process handler (thrown
 * there or by a command it dispatched) or a delayed command, the runtime dead-letters the run at
 * once instead of retrying it.
 */
export class DomainError extends BoundaError {
  constructor(message: string, options?: ErrorOptions) {
    super("DOMAIN_ERROR", message, options);
  }
}

export interface ConcurrencyErrorArgs {
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}

/**
 * Thrown when an append finds the stream at a version other than the one the handler decided on.
 * A command is retried `runtime.commands.concurrencyRetries` times before it surfaces.
 */
export class ConcurrencyError extends BoundaError {
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor({ streamId, expectedVersion, actualVersion }: ConcurrencyErrorArgs) {
    super(
      "CONCURRENCY_CONFLICT",
      `Stream ${streamId} is at version ${actualVersion}, expected ${expectedVersion}`,
    );
    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * One validation problem, in the shape produced by Standard Schema compatible validators.
 */
export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Thrown when a payload or the configuration fails validation.
 */
export class ValidationError extends BoundaError {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super("VALIDATION_FAILED", message);
    this.issues = issues;
  }
}

export interface ClaimLostErrorArgs {
  readonly subscriber: string;
  readonly eventId: string;
}

/**
 * Thrown by an inbox ledger asked to settle or renew a claim by an id it no longer holds: the
 * lease expired and another runner claimed the event. Whatever the settling was part of rolls
 * back, and a rejected renewal stops the attempt before the handler runs again.
 */
export class ClaimLostError extends BoundaError {
  readonly subscriber: string;
  readonly eventId: string;

  constructor({ subscriber, eventId }: ClaimLostErrorArgs) {
    super("CLAIM_LOST", `The claim of ${subscriber} on ${eventId} belongs to another runner`);
    this.subscriber = subscriber;
    this.eventId = eventId;
  }
}

export interface DeadLetterSettledErrorArgs {
  readonly id: string;
  /**
   * The status the letter was found in, when it was read.
   */
  readonly status?: string | undefined;
}

/**
 * Thrown when a dead letter is replayed or discarded once it is no longer `failed`: another
 * replay or discard settled it first, before or while this one ran. Of two operators settling
 * one letter only the first gets through; a policy's or a command's replay refused this way
 * writes nothing.
 */
export class DeadLetterSettledError extends BoundaError {
  readonly id: string;

  constructor({ id, status }: DeadLetterSettledErrorArgs) {
    super(
      "DEAD_LETTER_SETTLED",
      status === undefined
        ? `Dead letter "${id}" is no longer failed: another replay or discard settled it`
        : `Dead letter "${id}" was already ${status}`,
    );
    this.id = id;
  }
}

/**
 * Thrown by a scheduler asked to complete, fail, defer or renew a claimed command by a claim it no
 * longer holds: the lease expired and another runner claimed the command, or the command was
 * cancelled. Whatever the settling was part of rolls back, and a rejected renewal stops the run
 * before it starts again, so a run that outlived its claim writes nothing.
 */
export class ScheduledClaimLostError extends BoundaError {
  readonly dedupeKey: string;

  constructor(dedupeKey: string) {
    super(
      "SCHEDULED_CLAIM_LOST",
      `The claim on scheduled command ${dedupeKey} is no longer held: another runner claimed it, or it was cancelled`,
    );
    this.dedupeKey = dedupeKey;
  }
}

/**
 * Thrown when a requested aggregate, read model row or registry entry does not exist.
 */
export class NotFoundError extends BoundaError {
  constructor(message: string, options?: ErrorOptions) {
    super("NOT_FOUND", message, options);
  }
}

/**
 * Thrown at boot when the configuration or the registry is malformed: a module missing a required
 * export, a collaborator without an implementation, an unknown storage type.
 */
export class ConfigurationError extends BoundaError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_CONFIGURATION", message, options);
  }
}

/**
 * Thrown when a command handler returns events that do not fit whether its aggregate exists: an
 * aggregate one of whose events exports `create` starts with such an event, and an event that only
 * exports `create` cannot go on an aggregate that exists. A bug in the handler, not a refusal:
 * nothing is stored, and a reaction that dispatched the command is never retried for it.
 */
export class CreationOrderError extends BoundaError {
  constructor(message: string) {
    super("CREATION_ORDER", message);
  }
}

/**
 * Thrown when a reactive chain exceeds the configured `maxChainDepth`.
 */
export class ChainDepthExceededError extends BoundaError {
  readonly depth: number;
  readonly maxDepth: number;

  constructor(depth: number, maxDepth: number) {
    super("CHAIN_DEPTH_EXCEEDED", `Reactive chain reached depth ${depth}, maximum is ${maxDepth}`);
    this.depth = depth;
    this.maxDepth = maxDepth;
  }
}

/**
 * Thrown by a rebuild that another rebuild of the same read model has taken over. Only the most
 * recent rebuild writes: the older one stops at its next step and leaves its work to the newer.
 */
export class RebuildSupersededError extends BoundaError {
  readonly readModel: string;

  constructor(readModel: string) {
    super(
      "REBUILD_SUPERSEDED",
      `Another rebuild of read model "${readModel}" took over; this one stopped without writing`,
    );
    this.readModel = readModel;
  }
}
