import { DomainError, ValidationError, type ValidationIssue } from "@bounda-dev/core";
import { data } from "react-router";

export interface Failure {
  readonly error: string;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Turns the errors a command is expected to throw into responses: a validation failure is a 400
 * with its issues, a domain rule is a 409. Anything else is a bug and propagates.
 */
export const failure = (error: unknown) => {
  if (error instanceof ValidationError) {
    return data<Failure>({ error: error.message, issues: error.issues }, { status: 400 });
  }
  if (error instanceof DomainError) {
    return data<Failure>({ error: error.message, issues: [] }, { status: 409 });
  }
  throw error;
};

export const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
