import type { ResolvedRetryConfig } from "../../config/types.ts";
import { BoundaError } from "../../contracts/errors.ts";

export type FailureKind = "terminal" | "retriable";

const TERMINAL_CODES: ReadonlySet<string> = new Set([
  "DOMAIN_ERROR",
  "FOREIGN_REJECTION",
  "VALIDATION_FAILED",
  "INVALID_CONFIGURATION",
  "NOT_FOUND",
  "CHAIN_DEPTH_EXCEEDED",
  "CREATION_ORDER",
  "IDEMPOTENCY_KEY_CONFLICT",
  "PROCESSING_RESTRICTED",
]);

export interface ClassifyFailureFunction {
  (error: unknown): FailureKind;
}

/**
 * Decides whether a handler failure is worth retrying. Errors that describe the request itself
 * (domain rules, validation, configuration) will fail the same way every time; anything else is
 * assumed transient.
 */
export const classifyFailure: ClassifyFailureFunction = (error) =>
  error instanceof BoundaError && TERMINAL_CODES.has(error.code) ? "terminal" : "retriable";

export interface RetryDelayArgs {
  readonly retry: ResolvedRetryConfig;
  readonly attempt: number;
}

export interface RetryDelayFunction {
  (args: RetryDelayArgs): number;
}

/**
 * Milliseconds before retry number `attempt`, 1 for the first.
 */
export const retryDelayMs: RetryDelayFunction = ({ retry, attempt }) => {
  const raw = (() => {
    switch (retry.strategy) {
      case "none":
        return 0;
      case "fixed":
        return retry.baseDelayMs;
      case "linear":
        return retry.baseDelayMs * attempt;
      case "exponential":
        return retry.baseDelayMs * 2 ** (attempt - 1);
    }
  })();
  return Math.min(raw, retry.maxDelayMs);
};

/**
 * What a failure may be recorded as where no text of the error may be kept: the class name, and
 * the code when it is a `BoundaError`.
 */
export interface ErrorIdentity {
  readonly errorName: string;
  readonly errorCode?: string;
}

export interface ErrorIdentityFunction {
  (error: unknown): ErrorIdentity;
}

/**
 * A value thrown that is no error, wrapped where a run of work fails so it can carry what the run
 * read. `errorIdentity` and `errorDetails` look through it, so it is recorded as the value it
 * wraps; `thrownValue` hands that value back to a caller of the app.
 */
export class ThrownValue extends Error {
  readonly value: unknown;

  constructor(value: unknown) {
    super(String(value), { cause: value });
    this.value = value;
  }
}

export interface AsErrorFunction {
  (thrown: unknown): Error;
}

/**
 * What was thrown, as an object that can carry what the run read: an `Error` as it is, any
 * other value wrapped in a `ThrownValue`.
 */
export const asError: AsErrorFunction = (thrown) =>
  thrown instanceof Error ? thrown : new ThrownValue(thrown);

export interface ThrownValueFunction {
  (error: unknown): unknown;
}

/**
 * What the work threw, unwrapped from a `ThrownValue`.
 */
export const thrownValue: ThrownValueFunction = (error) =>
  error instanceof ThrownValue ? error.value : error;

// A subclass that does not set `name` inherits `Error`'s: its constructor names the class.
const classOf = (error: Error): string =>
  error.name === "Error" && error.constructor.name !== "" ? error.constructor.name : error.name;

/**
 * `typeof` what was thrown when it is no error, since its text is all `errorDetails` can tell.
 */
export const errorIdentity: ErrorIdentityFunction = (thrown) => {
  const error = thrownValue(thrown);
  if (!(error instanceof Error)) return { errorName: typeof error };
  return error instanceof BoundaError
    ? { errorName: classOf(error), errorCode: error.code }
    : { errorName: classOf(error) };
};

export interface ErrorLabelFunction {
  (identity: ErrorIdentity): string;
}

/**
 * The identity as one line, `ValidationError (VALIDATION_FAILED)`: what the inbox and the
 * scheduler keep as the last error of a claim.
 */
export const errorLabel: ErrorLabelFunction = ({ errorName, errorCode }) =>
  errorCode === undefined ? errorName : `${errorName} (${errorCode})`;

export interface ErrorDetailsFunction {
  (error: unknown): { readonly message: string; readonly stack?: string };
}

export const errorDetails: ErrorDetailsFunction = (thrown) => {
  const error = thrownValue(thrown);
  return error instanceof Error
    ? { message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) }
    : { message: String(error) };
};
