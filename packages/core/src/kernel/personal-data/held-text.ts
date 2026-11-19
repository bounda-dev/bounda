import type { SealedValue } from "../../adapter/storage/personal-key-store.ts";

// How long a row past its retention that a restriction holds waits before it is read again: a
// restriction lifted in another instance tells nobody here.
export const HELD_RECHECK_MS = 3_600_000;

export interface StillOpensFunction {
  (
    open: (value: string | SealedValue) => Promise<string | null>,
    text: string | SealedValue,
  ): Promise<boolean>;
}

// Whether a restriction still has something to keep in an error text: none once a key it is sealed
// under is gone. A text that cannot be read for another reason is taken to open, so a restriction
// keeps it rather than lose it, and one row never stops the purge of the others.
export const stillOpens: StillOpensFunction = async (open, text) => {
  try {
    return (await open(text)) !== null;
  } catch {
    return true;
  }
};
