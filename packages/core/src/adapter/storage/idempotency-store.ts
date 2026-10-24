import type { DispatchResult, RejectedDispatch } from "../../contracts/command.ts";

/**
 * What a dispatch answered, as the idempotency store keeps it: the result of a command that was
 * stored or scheduled, or its rejection. A dispatch that failed is not kept.
 */
export type DispatchOutcome = DispatchResult | RejectedDispatch;

/**
 * A dispatch remembered under its idempotency key: the fingerprint of the command it was, what it
 * answered, and when the key may be used for another command.
 */
export interface IdempotencyRecord {
  readonly key: string;
  readonly fingerprint: string;
  readonly outcome: DispatchOutcome;
  readonly expiresAt: string;
}

export interface GetIdempotencyRecordArgs {
  readonly key: string;
  /**
   * The kernel clock's time: a record expired by then is as good as gone.
   */
  readonly now: Date;
}

export interface PutIdempotencyRecordArgs extends IdempotencyRecord {
  /**
   * The kernel clock's time: a record expired by then is replaced.
   */
  readonly now: Date;
}

export interface PurgeIdempotencyRecordsArgs {
  readonly now: Date;
}

/**
 * Remembers what a command dispatched with an idempotency key answered, so the same key answers
 * the same again. `put` must be atomic: of two dispatches racing for one key exactly one records
 * its outcome, and the other rejects with `IdempotencyKeyTakenError`, which rolls back whatever
 * the recording was part of.
 */
export interface IdempotencyStore {
  /**
   * The record under `key`, or `null` when there is none or it has expired.
   */
  get(args: GetIdempotencyRecordArgs): Promise<IdempotencyRecord | null>;
  /**
   * Records the outcome, taking the place of an expired record. Rejects with
   * `IdempotencyKeyTakenError` when the key holds a record that has not expired.
   */
  put(args: PutIdempotencyRecordArgs): Promise<void>;
  /**
   * Removes the records expired by `now`, and resolves to how many.
   */
  purge(args: PurgeIdempotencyRecordsArgs): Promise<number>;
}
