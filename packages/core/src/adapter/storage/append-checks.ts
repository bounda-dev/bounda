import { ConcurrencyError, ProcessingRestrictedError } from "../../contracts/errors.ts";
import { streamId } from "../../contracts/event.ts";
import type { AppendArgs } from "./event-store.ts";

/**
 * Thrown by an append whose events depend on a key the person no longer holds: they were forgotten
 * since the events were decided, so the command is decided again, as on a stream that moved.
 * Forgotten even when they hold a key again: one given to them after `forget` is another key.
 */
export class ForgottenSinceLoadError extends ConcurrencyError {
  readonly personId: string;

  constructor(
    args: Pick<AppendArgs, "aggregateType" | "aggregateId" | "expectedVersion">,
    person: string,
  ) {
    const { expectedVersion } = args;
    super({ streamId: streamId(args), expectedVersion, actualVersion: expectedVersion });
    this.message = `Person ${person} was forgotten since ${streamId(args)} was loaded at version ${expectedVersion}`;
    this.personId = person;
  }
}

// The persons an append asks the store to check, each once: `keyed`, named in `persons` with a
// fingerprint, whose key rows `checkAppend` reads; `touched`, named in `touches`, whose restriction
// it reads.
export interface AppendPersons {
  readonly keyed: readonly string[];
  readonly touched: readonly string[];
}

export interface AppendPersonsOfFunction {
  (args: AppendArgs): AppendPersons;
}

// Whom `args` asks the store to check, so a store reads only those rows, and none for an append
// that names nobody.
export const appendPersonsOf: AppendPersonsOfFunction = ({ persons = [], touches = [] }) => ({
  keyed: [
    ...new Set(
      persons.filter(({ fingerprint }) => fingerprint !== null).map(({ person }) => person),
    ),
  ],
  touched: [...new Set(touches)],
});

export interface CheckAppendArgs {
  readonly args: AppendArgs;
  /**
   * The fingerprint of the key the person holds as the append's transaction reads it; `null`
   * when they hold none.
   */
  readonly fingerprintOf: (person: string) => string | null;
  /**
   * Whether the processing of the person's data is restricted, as the same transaction reads it.
   */
  readonly restricted: (person: string) => boolean;
}

export interface CheckAppendFunction {
  (args: CheckAppendArgs): void;
}

/**
 * Throws `ProcessingRestrictedError` when a person `touches` names is restricted, and else
 * `ForgottenSinceLoadError` when a person `persons` names with a fingerprint no longer holds
 * that key. A store calls it in the transaction that writes the events, on what that transaction
 * reads, so a `restrict` or `forget` committing beside the append is ordered before it or after
 * it, never across.
 */
export const checkAppend: CheckAppendFunction = ({ args, fingerprintOf, restricted }) => {
  for (const person of args.touches ?? []) {
    if (restricted(person)) throw new ProcessingRestrictedError(person);
  }
  for (const { person, fingerprint } of args.persons ?? []) {
    if (fingerprint !== null && fingerprintOf(person) !== fingerprint) {
      throw new ForgottenSinceLoadError(args, person);
    }
  }
};
