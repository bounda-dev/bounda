import type { Hold } from "../adapter/storage/hold.ts";

export interface EarliestHoldEndFunction {
  (holds: Iterable<Hold | null>, after: Date): Date | null;
}

export const earliestHoldEnd: EarliestHoldEndFunction = (holds, after) => {
  const from = after.toISOString();
  let earliest: string | null = null;
  for (const hold of holds) {
    if (hold === null || hold.until <= from) continue;
    if (earliest === null || hold.until < earliest) earliest = hold.until;
  }
  return earliest === null ? null : new Date(earliest);
};
