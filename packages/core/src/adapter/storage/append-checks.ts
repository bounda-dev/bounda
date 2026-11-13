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

// The persons an append asks the store to check, each once: `keyed`, named with a fingerprint in
// `persons` or `seals`, whose key rows `checkAppend` reads; `restricted`, named in `touches` or
// `seals`, whose restrictions it reads.
export interface AppendPersons {
  readonly keyed: readonly string[];
  readonly restricted: readonly string[];
}

export interface AppendPersonsOfFunction {
  (args: AppendArgs): AppendPersons;
}

// Whom `args` asks the store to check, so a store reads only those rows, and none for an append
// that names nobody.
export const appendPersonsOf: AppendPersonsOfFunction = ({
  persons = [],
  touches = [],
  seals = [],
}) => ({
  keyed: [
    ...new Set(
      [...persons, ...seals]
        .filter(({ fingerprint }) => fingerprint !== null)
        .map(({ person }) => person),
    ),
  ],
  restricted: [...new Set([...touches, ...seals.map(({ person }) => person)])],
});

/**
 * A key of a person as the append's transaction reads it: `held` in force, `retained` when a
 * forgetting kept it past it, with the category it seals.
 */
export interface KeyRead {
  readonly state: "held" | "retained";
  readonly category: string;
}

/**
 * A restriction a person asked for, as the append's transaction reads it: of a category, or `null`
 * for the person as a whole.
 */
export interface RestrictionRead {
  readonly category: string | null;
}

export interface CheckAppendArgs {
  readonly args: AppendArgs;
  /**
   * `null` once the key is gone.
   */
  readonly keyOf: (person: string, fingerprint: string) => KeyRead | null;
  readonly restrictionsOf: (person: string) => readonly RestrictionRead[];
}

export interface CheckAppendFunction {
  (args: CheckAppendArgs): void;
}

/**
 * Throws `ProcessingRestrictedError` for a person `touches` names who is restricted as a whole, or
 * a key `seals` names whose category, or whose person as a whole, is restricted; else
 * `ForgottenSinceLoadError` for a person `persons` or `seals` names with a fingerprint who no
 * longer holds that key, or holds it retained where it was read in force. A store calls it in the
 * transaction that writes the events, on what that transaction reads, so a `restrict` or `forget`
 * committing beside the append is ordered before it or after it, never across. Reading
 * restricted data is refused before the work runs, by the runtime.
 */
export const checkAppend: CheckAppendFunction = ({ args, keyOf, restrictionsOf }) => {
  const covers = (person: string, category: string | null): boolean =>
    restrictionsOf(person).some((row) => row.category === null || row.category === category);
  for (const person of args.touches ?? []) {
    if (covers(person, null)) throw new ProcessingRestrictedError(person);
  }
  for (const { person, fingerprint } of args.seals ?? []) {
    if (fingerprint === null) continue;
    const category = keyOf(person, fingerprint)?.category ?? null;
    if (covers(person, category)) throw new ProcessingRestrictedError(person);
  }
  for (const { person, fingerprint, retained } of [
    ...(args.persons ?? []),
    ...(args.seals ?? []),
  ]) {
    if (fingerprint === null) continue;
    const key = keyOf(person, fingerprint);
    if (key === null || (key.state === "retained" && retained !== true)) {
      throw new ForgottenSinceLoadError(args, person);
    }
  }
};
