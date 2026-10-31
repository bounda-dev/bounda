import type { DeadLetter } from "../storage/dead-letter-store.ts";
import { codePointOrder } from "./order.ts";

export interface ByFirstFailureFunction {
  (a: DeadLetter, b: DeadLetter): number;
}

/**
 * The order of `DeadLetterStore.list` and `DeadLetterStore.forget`: `firstFailedAt`, then `id` by
 * code point. For a store whose engine hands rows back unordered, as `RETURNING` does.
 */
export const byFirstFailure: ByFirstFailureFunction = (a, b) =>
  codePointOrder(a.firstFailedAt, b.firstFailedAt) || codePointOrder(a.id, b.id);
