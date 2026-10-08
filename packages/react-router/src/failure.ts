import { DomainError, ValidationError, type ValidationIssue } from "@bounda-dev/core";
import { data } from "react-router";

/**
 * What `failure` returns as `actionData`: the message to show, the payload's issues when it did
 * not validate, and the rejection's code when the command's handler rejected it.
 */
export interface Failure {
  readonly error: string;
  readonly issues: readonly ValidationIssue[];
  readonly rejected?: string;
}

export interface FailureFunction {
  (error: unknown): ReturnType<typeof data<Failure>>;
}

/**
 * Turns what a command is expected to throw into an action's answer, for the form to show: a
 * `ValidationError` becomes a 400 with its issues, a `DomainError`, the command's rejection, a 409
 * with its code in `rejected`. Anything else is rethrown, for the route's `ErrorBoundary`.
 *
 * ```ts
 * try {
 *   await context.get(bounda).commands.registerUser({ userId, email, name });
 * } catch (error) {
 *   return failure(error);
 * }
 * ```
 */
export const failure: FailureFunction = (error) => {
  if (error instanceof ValidationError) {
    return data<Failure>({ error: error.message, issues: error.issues }, { status: 400 });
  }
  if (error instanceof DomainError) {
    return data<Failure>(
      { error: error.message, issues: [], rejected: error.rejected },
      { status: 409 },
    );
  }
  throw error;
};
