import type { ResolvedRetryConfig } from "../../config/types.ts";
import { BoundaError } from "../../contracts/errors.ts";

export type FailureKind = "terminal" | "retriable";

const TERMINAL_CODES: ReadonlySet<string> = new Set([
  "DOMAIN_ERROR",
  "VALIDATION_FAILED",
  "INVALID_CONFIGURATION",
  "NOT_FOUND",
  "CHAIN_DEPTH_EXCEEDED",
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
 * Milliseconds to wait before retry number `attempt` (1 for the first retry), capped at
 * `maxDelayMs`. Strategy `none` never retries.
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

export interface ErrorDetailsFunction {
  (error: unknown): { readonly message: string; readonly stack?: string };
}

/**
 * Message and stack of anything thrown.
 */
export const errorDetails: ErrorDetailsFunction = (error) =>
  error instanceof Error
    ? { message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) }
    : { message: String(error) };
