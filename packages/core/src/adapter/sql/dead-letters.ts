import type { StoredDeadLetter } from "../storage/dead-letter-store.ts";
import type { SealedValue } from "../storage/personal-key-store.ts";
import { codePointOrder } from "./order.ts";

export interface ByFirstFailureFunction {
  (a: StoredDeadLetter, b: StoredDeadLetter): number;
}

/**
 * The order of `DeadLetterStore.list` and `DeadLetterStore.forget`: `firstFailedAt`, then `id` by
 * code point. For a store whose engine hands rows back unordered, as `RETURNING` does.
 */
export const byFirstFailure: ByFirstFailureFunction = (a, b) =>
  codePointOrder(a.firstFailedAt, b.firstFailedAt) || codePointOrder(a.id, b.id);

export interface EncodeErrorTextFunction {
  (text: string | SealedValue): string;
}

/**
 * A dead letter's `errorMessage` or `errorStack` as a text column keeps it: as JSON, so text in the
 * clear and a sealed envelope never read alike. `decodeErrorText` reads it back.
 */
export const encodeErrorText: EncodeErrorTextFunction = (text) => JSON.stringify(text);

export interface DecodeErrorTextFunction {
  (column: unknown): string | SealedValue;
}

export const decodeErrorText: DecodeErrorTextFunction = (column) =>
  JSON.parse(String(column)) as string | SealedValue;

export interface ResolvedAtOfEarlierLettersFunction {
  (table: string): string;
}

/**
 * For a table that has just gained `resolved_at`: when a letter left `failed` was not kept, so it
 * takes its last failure, the latest time known before then, and the retention never keeps it
 * past its term.
 */
export const resolvedAtOfEarlierLetters: ResolvedAtOfEarlierLettersFunction = (table) =>
  `UPDATE ${table} SET "resolved_at" = "last_failed_at" WHERE "status" <> 'failed'`;
