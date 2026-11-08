import type { KeyedPerson } from "../../adapter/storage/personal-key-store.ts";

// What the failed run read, by the error it failed with: the error is what reaches whoever files
// its dead letter, after the unit of work that read is gone.
const readsByError = new WeakMap<object, KeyedPerson[]>();

export interface NoteReadsFunction {
  (error: unknown, reads: readonly KeyedPerson[]): void;
}

/**
 * Remembers that the run that threw `error` read each person's data under the key named, adding
 * to what was noted for it before. A thrown value that is not an object cannot carry it: it is
 * noted on a wrapper nobody reads again.
 */
export const noteReads: NoteReadsFunction = (error, reads) => {
  const target: object = Object(error);
  const noted = readsByError.get(target);
  if (noted === undefined) readsByError.set(target, [...reads]);
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
  (args: ReadUnderArgs): readonly string[];
}

/**
 * The fingerprints of the keys the failed work read the person's data under.
 */
export const readUnder: ReadUnderFunction = ({ person, error, also = [] }) => {
  const noted = readsByError.get(Object(error)) ?? [];
  const fingerprints = new Set<string>();
  for (const read of [...noted, ...also]) {
    if (read.person === person && read.fingerprint !== null) fingerprints.add(read.fingerprint);
  }
  return [...fingerprints];
};
