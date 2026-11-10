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
];

const vouched = new WeakSet<Error>();

export interface RuntimeTextFunction {
  <E extends Error>(error: E): E;
}

// For an error the runtime makes with a message written from names and ids alone: logs, spans
// and the CLI carry its text even when they carry no error's text.
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
