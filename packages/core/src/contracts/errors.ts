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

declare const rejectionBrand: unique symbol;

/**
 * A code a command declares in `rejections` and its message, as only the handler's `reject`
 * produces it.
 */
export interface Rejection<Code extends string = string> {
  readonly code: Code;
  readonly message: string;
  readonly [rejectionBrand]: true;
}

export interface RejectionOfFunction {
  <Code extends string>(code: Code, message: string): Rejection<Code>;
}

export const rejectionOf: RejectionOfFunction = <Code extends string>(
  code: Code,
  message: string,
) => ({ code, message }) as Rejection<Code>;

/**
 * A command's rejection: a rule of the domain forbids what was asked. A handler makes one with
 * `reject(code)`, one of the codes its module declares in `rejections`, never with `new`.
 * `app.commands` throws it to the caller, with the code in `rejected`, and nothing is retried. A
 * policy or process handler gets it as a value instead: its `commands.<name>()` resolves with
 * `rejected` set to the code.
 */
export class DomainError<Code extends string = string> extends BoundaError {
  readonly rejected: Code;

  constructor(rejection: Rejection<Code>, options?: ErrorOptions) {
    super("DOMAIN_ERROR", rejection.message, options);
    this.rejected = rejection.code;
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
  readonly handler: string;
  readonly eventId: string;
}

/**
 * Thrown by an inbox ledger asked to settle or renew a claim by an id it no longer holds: the
 * lease expired and another runner claimed the event. Whatever the settling was part of rolls
 * back, and a rejected renewal stops the attempt before the handler runs again.
 */
export class ClaimLostError extends BoundaError {
  readonly handler: string;
  readonly eventId: string;

  constructor({ handler, eventId }: ClaimLostErrorArgs) {
    super("CLAIM_LOST", `The claim of ${handler} on ${eventId} belongs to another runner`);
    this.handler = handler;
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
 * Thrown when a dead letter is retried or discarded once it is no longer `failed`: another
 * retry or discard settled it first, before or while this one ran. Of two operators settling
 * one letter only the first gets through; a policy's or a scheduled command's retry refused this
 * way writes nothing.
 */
export class DeadLetterSettledError extends BoundaError {
  readonly id: string;

  constructor({ id, status }: DeadLetterSettledErrorArgs) {
    super(
      "DEAD_LETTER_SETTLED",
      status === undefined
        ? `Dead letter "${id}" is no longer failed: another retry or discard settled it`
        : `Dead letter "${id}" was already ${status}`,
    );
    this.id = id;
  }
}

/**
 * Thrown when a dead letter cannot be retried in the app as it now is: its policy, process or
 * scheduled command is no longer in the registry, its policy or process no longer handles the
 * event, or its process instance failed on another step, whose letter has to be retried first.
 * Nothing runs, and the letter stays `failed`.
 */
export class DeadLetterNotRetriableError extends BoundaError {
  constructor(message: string) {
    super("DEAD_LETTER_NOT_RETRIABLE", message);
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
 * The app and its stored data do not fit together, which no retry fixes: a malformed configuration
 * or registry at boot, a stored event or a dead letter the registry no longer knows, a port a test
 * left out, a read model that needs a rebuild, a query the adapter cannot run.
 */
export class ConfigurationError extends BoundaError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_CONFIGURATION", message, options);
  }
}

/**
 * Thrown when a command handler returns events that do not fit whether its aggregate exists: an
 * aggregate one of whose events exports `begin` starts with such an event, and an event that only
 * exports `begin` cannot go on an aggregate that exists. A bug in the handler, not a refusal:
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
