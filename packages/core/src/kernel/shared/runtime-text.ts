import {
  ChainDepthExceededError,
  ClaimLostError,
  ConcurrencyError,
  DeadLetterSettledError,
  ForgetLedgerTimeoutError,
  ForgetLedgerUnavailableError,
  ForgetLedgerUnreconciledError,
  ProcessingRestrictedError,
  RebuildSupersededError,
  TenantForgottenError,
} from "../../contracts/errors.ts";
import { thrownValue } from "./retry.ts";
import { HandlerTimeoutError } from "./timeout.ts";

// Errors whose constructor composes the whole message from names, ids, codes and numbers: whoever
// makes one, its text carries nothing a handler read. A subclass may set its own message, so only
// the class itself counts.
const COMPOSED: readonly (abstract new (...args: never[]) => Error)[] = [
  ChainDepthExceededError,
  ClaimLostError,
  ConcurrencyError,
  DeadLetterSettledError,
  ForgetLedgerTimeoutError,
  ForgetLedgerUnavailableError,
  ForgetLedgerUnreconciledError,
  HandlerTimeoutError,
  ProcessingRestrictedError,
  RebuildSupersededError,
  TenantForgottenError,
];

const vouched = new WeakSet<Error>();

export interface RuntimeTextFunction {
  <E extends Error>(error: E): E;
}

/**
 * Vouches that `error`'s message is written from names, ids, codes and numbers alone, never from
 * data a handler read, and returns it: logs, spans and the CLI then carry its text even where they
 * carry no error's text (`runtime.telemetry.errorText`). For an adapter's or a store's own
 * refusals, such as a binding a configuration names and the host lacks.
 */
export const runtimeText: RuntimeTextFunction = (error) => {
  vouched.add(error);
  return error;
};

export interface HasRuntimeTextFunction {
  (thrown: unknown): boolean;
}

export const hasRuntimeText: HasRuntimeTextFunction = (thrown) => {
  const error = thrownValue(thrown);
  if (!(error instanceof Error)) return false;
  const prototype: unknown = Object.getPrototypeOf(error);
  return vouched.has(error) || COMPOSED.some((composed) => composed.prototype === prototype);
};
