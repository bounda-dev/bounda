import type { ErrorText } from "../../config/types.ts";
import { errorDetails, errorIdentity } from "./retry.ts";
import { hasRuntimeText } from "./runtime-text.ts";

/**
 * What a log line says of an error.
 */
export interface ErrorFields {
  /**
   * The error's class, or `typeof` what was thrown when it is no error.
   */
  readonly errorName: string;
  /**
   * The `code` of a `BoundaError`.
   */
  readonly errorCode?: string;
  /**
   * With `errorText: "include"`, or for an error of Bounda's whose message it writes from names
   * and ids alone, such as `ConcurrencyError` or a dead letter that is not found.
   */
  readonly errorMessage?: string;
  /**
   * Only with `errorText: "include"`, and when the error has one.
   */
  readonly errorStack?: string;
}

export interface ErrorFieldsArgs {
  readonly error: unknown;
  /**
   * Defaults to `"omit"`, as `runtime.telemetry.errorText` does.
   */
  readonly errorText?: ErrorText | undefined;
}

export interface ErrorFieldsFunction {
  (args: ErrorFieldsArgs): ErrorFields;
}

/**
 * An error as the runtime's logs carry it: its class name and its `code`, plus its message and
 * stack only with `errorText: "include"`, or its message alone for an error of Bounda's whose
 * message quotes nothing a handler read. For code around the app, such as a host's request
 * handler, to log an error under the rule `runtime.telemetry.errorText` sets for the runtime.
 */
export const errorFields: ErrorFieldsFunction = ({ error, errorText = "omit" }) => {
  const identity = errorIdentity(error);
  if (errorText === "omit") {
    return hasRuntimeText(error)
      ? { ...identity, errorMessage: errorDetails(error).message }
      : identity;
  }
  const { message, stack } = errorDetails(error);
  return {
    ...identity,
    errorMessage: message,
    ...(stack === undefined ? {} : { errorStack: stack }),
  };
};
