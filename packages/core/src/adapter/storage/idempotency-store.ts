import type { DispatchResult, RejectedDispatch } from "../../contracts/command.ts";
import type { KeyedPerson, ListByPersonArgs } from "./personal-key-store.ts";

/**
 * What a dispatch answered, as the idempotency store keeps it: the result of a command that was
 * stored or scheduled, or its rejection. A dispatch that failed is not kept.
 */
export type DispatchOutcome = DispatchResult | RejectedDispatch;

/**
 * What a dispatch was and what it answered, sealed by the runtime: a JSON object the store keeps
 * as it is and never reads.
 */
export type StoredAnswer = object;

/**
 * A dispatch remembered under its idempotency key until `expiresAt`. `answer` is sealed under the
 * key of every person it names in `persons`, each with the fingerprint of that key, or under the
 * database's key when it names nobody. An answer erased, because a person it names was forgotten
 * or their data redacted, is `null` and names nobody: the key stays taken until it expires.
 */
export interface IdempotencyRecord {
  readonly key: string;
  readonly answer: StoredAnswer | null;
  readonly expiresAt: string;
  readonly persons: readonly KeyedPerson[];
}

export interface ErasedFunction {
  (record: IdempotencyRecord): IdempotencyRecord;
}

export const erased: ErasedFunction = ({ key, expiresAt }) => ({
  key,
  answer: null,
  expiresAt,
  persons: [],
});

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

export interface ListIdempotencyRecordsArgs extends ListByPersonArgs {
  /**
   * The kernel clock's time: a record expired by then is left out.
   */
  readonly now: Date;
}

export interface ListAllIdempotencyRecordsArgs {
  /**
   * The kernel clock's time: a record expired by then is left out.
   */
  readonly now: Date;
  /**
   * Only the records filed after this key, which pages through them while others come and go.
   */
  readonly after?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface EraseIdempotencyRecordArgs {
  readonly key: string;
  /**
   * Where the key is filed from now on, when another than `key`: for a record filed by the
   * caller's key itself, before keys were filed by their HMAC.
   */
  readonly filed?: string;
  /**
   * The kernel clock's time: a record expired by then is left as it is.
   */
  readonly now: Date;
}

export interface ResealIdempotencyRecordArgs {
  readonly key: string;
  /**
   * The answer as it was read, which the record must still hold.
   */
  readonly from: StoredAnswer;
  readonly answer: StoredAnswer;
  readonly persons: readonly KeyedPerson[];
  /**
   * The kernel clock's time: a record expired by then is left as it is.
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
 *
 * An answer lives only as long as the keys it is sealed under stay in force: `put` records it
 * erased, the key alone, when a person it names with a fingerprint no longer holds the key of that
 * fingerprint in force (one named with `null` was read in the clear and needs none), checked in
 * the same statement; and `forget` erases every answer that names the person under a key outside
 * `keep`, or read in the clear.
 */
export interface IdempotencyStore {
  /**
   * The record under `key`, or `null` when there is none or it has expired.
   */
  get(args: GetIdempotencyRecordArgs): Promise<IdempotencyRecord | null>;
  /**
   * Records the dispatch, taking the place of an expired record. Rejects with
   * `IdempotencyKeyTakenError` when the key holds a record that has not expired.
   */
  put(args: PutIdempotencyRecordArgs): Promise<void>;
  /**
   * The records that have not expired whose `persons` names the person, by `key`.
   */
  listByPerson(args: ListIdempotencyRecordsArgs): Promise<readonly IdempotencyRecord[]>;
  /**
   * Every record that has not expired, by `key`.
   */
  list(args: ListAllIdempotencyRecordsArgs): Promise<readonly IdempotencyRecord[]>;
  /**
   * Erases the answer of the record under `key` unless it has expired, keeping the key taken
   * until it expires. With `filed`, the record erased is filed there, with the same expiry, and
   * leaves `key`; a record that has not expired under `filed` is kept as it is. Only the runtime
   * calls it, for answers sealed under other marks or filed by the caller's key.
   */
  erase(args: EraseIdempotencyRecordArgs): Promise<void>;
  /**
   * Writes the record under `key` again with `answer` and `persons`, only while it holds `from`
   * and has not expired: an answer erased or replaced meanwhile is left as it is. Only the runtime
   * calls it, to seal answers under new keys.
   */
  reseal(args: ResealIdempotencyRecordArgs): Promise<void>;
  /**
   * Removes the records expired by `now`, and resolves to how many.
   */
  purge(args: PurgeIdempotencyRecordsArgs): Promise<number>;
  forget(person: string, keep?: readonly string[]): Promise<void>;
  /**
   * Removes every record: what forgetting the tenant does.
   */
  clear(): Promise<void>;
}
