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
 * Thrown by user code inside a command handler to reject the command. The runtime returns it to
 * the caller as is and does not retry or dead-letter it.
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
 * The command pipeline retries the command a configurable number of times before surfacing it.
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
