import { type KeyedPerson, keyedPersonId } from "../../adapter/storage/personal-key-store.ts";

// What the failed run read, by the error it failed with: the error is what reaches whoever files
// its dead letter, after the unit of work that read is gone.
const readsByError = new WeakMap<object, KeyedPerson[]>();

export interface NoteReadsFunction {
  (error: Error, reads: readonly KeyedPerson[]): void;
}

/**
 * Remembers that the run that threw `error` read each person's data under the key named, adding
 * to what was noted for it before.
 */
export const noteReads: NoteReadsFunction = (error, reads) => {
  const noted = readsByError.get(error);
  if (noted === undefined) readsByError.set(error, [...reads]);
  else noted.push(...reads);
};

export interface ReadUnderArgs {
  readonly person: string;
  readonly error: unknown;
  /**
   * What the work read besides what its unit noted, as the event it ran on.
   */
  readonly also?: readonly KeyedPerson[];
}

export interface ReadUnderFunction {
  (args: ReadUnderArgs): readonly KeyedPerson[];
}

/**
 * The keys the failed work read the person's data under, each once, as it read them: kept past a
 * forgetting, `retained`, or in force.
 */
export const readUnder: ReadUnderFunction = ({ person, error, also = [] }) => {
  const noted = readsByError.get(Object(error)) ?? [];
  const reads = new Map<string, KeyedPerson>();
  for (const read of [...noted, ...also]) {
    if (read.person === person && read.fingerprint !== null) reads.set(keyedPersonId(read), read);
  }
  return [...reads.values()];
};
