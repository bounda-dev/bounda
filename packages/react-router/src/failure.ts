import type { ValidationIssue } from "@bounda-dev/core";
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
 * with its code in `rejected`. It goes by the error's `code`, so the same refusals that come back
 * from a Durable Object count too. Anything else is rethrown, for the route's `ErrorBoundary`.
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
  // By code rather than class: from a Durable Object a refusal comes back as a plain `Error`.
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  if (code === "VALIDATION_FAILED") {
    const { message, issues } = error as Error & { readonly issues: readonly ValidationIssue[] };
    return data<Failure>({ error: message, issues }, { status: 400 });
  }
  if (code === "DOMAIN_ERROR") {
    const { message, rejected } = error as Error & { readonly rejected: string };
    return data<Failure>({ error: message, issues: [], rejected }, { status: 409 });
  }
  throw error;
};
