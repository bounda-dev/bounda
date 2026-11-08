import type { KeyedPerson, SealedValue } from "./personal-key-store.ts";

/**
 * What gave up: a policy or process handler (a delayed policy run included), or a scheduled
 * command, one dispatched with `delay`.
 */
export type DeadLetterKind = "policy" | "process" | "scheduled";

export type DeadLetterErrorType = "terminal" | "retriable_exhausted";

export type DeadLetterStatus = "failed" | "retried" | "discarded";

/**
 * A handler run that gave up, as the store keeps it. `status` is `failed` until an operator
 * retries or discards it. The text of the error is kept sealed under `person`, so no store holds
 * in the clear what a handler quoted of a person; `app.deadLetters` hands the letter out opened,
 * as `DeadLetter`.
 */
export interface StoredDeadLetter {
  readonly id: string;
  readonly kind: DeadLetterKind;
  /**
   * The policy or process name, `order.notifyOnOrderPlaced`, or the scheduled command's type,
   * `PlaceOrder`.
   */
  readonly handler: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /**
   * The person the failed work names: the one the event names for a policy or process letter,
   * the one the payload names for a scheduled command. `null` for a deadline, or for work that
   * names nobody.
   */
  readonly person: string | null;
  readonly errorType: DeadLetterErrorType;
  /**
   * The error's class name, `ValidationError`, or the type of what was thrown when it is no error.
   */
  readonly errorName: string;
  /**
   * The error's `code` when it is a `BoundaError`.
   */
  readonly errorCode?: string;
  /**
   * The error's message, sealed under `person`'s key, and in the clear only when `person` is
   * `null`.
   */
  readonly errorMessage: string | SealedValue;
  /**
   * The error's stack when it has one, sealed as `errorMessage` is.
   */
  readonly errorStack?: string | SealedValue;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly status: DeadLetterStatus;
  /**
   * When the letter left `failed`, retried or discarded; absent while it is `failed`.
   */
  readonly resolvedAt?: string;
  /**
   * Only on `scheduled` letters: the dropped command's payload, to dispatch it again.
   * Policy and process letters point at a stored event instead.
   */
  readonly payload?: unknown;
  /**
   * Only on `scheduled` letters whose payload holds personal fields sealed: whose they are, with
   * the key each is sealed under, as the scheduled command named them. What `forget` removes a
   * letter by: a policy or process letter names nobody here, so a forget leaves it, its instance
   * still waiting for its retry, and its error text reads as `null` from then on.
   */
  readonly persons?: readonly KeyedPerson[];
}

export type NewDeadLetter = Omit<StoredDeadLetter, "status" | "resolvedAt">;

/**
 * A dead letter as `app.deadLetters` hands it out: the error's message and stack opened with
 * `person`'s key, `null` once the person was forgotten.
 */
export interface DeadLetter extends Omit<StoredDeadLetter, "errorMessage" | "errorStack"> {
  readonly errorMessage: string | null;
  readonly errorStack?: string | null;
  /**
   * Process letters only: how many steps wait on the instance. While the letter is `failed`, the
   * events parked behind it for its retry to handle; on the letter a retry returns, the steps
   * still waiting because the process failed again, the one it failed on included, so `0` there
   * means the instance resumed, or, for a follow-up of a timed-out instance, that nothing waits.
   * Filled in by `app.deadLetters`, never stored.
   */
  readonly parked?: number;
}

/**
 * What `listFailed` finds: the `failed` letters of work that names `person`, failed with the
 * error `errorCode`.
 */
export interface ListFailedDeadLettersArgs {
  readonly person: string;
  readonly errorCode: string;
}

/**
 * What `purge` removes: up to `limit` letters resolved at or before `resolvedBy`.
 */
export interface PurgeDeadLettersArgs {
  readonly resolvedBy: Date;
  readonly limit: number;
}

export interface ListDeadLettersArgs {
  readonly kind?: DeadLetterKind;
  readonly handler?: string;
  readonly status?: DeadLetterStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * `add` stores a letter as `failed` and resolves to what is stored; adding an `id` again keeps
 * the first letter. `errorMessage` and `errorStack` are kept as they come, text or `SealedValue`,
 * and read back as stored.
 */
export interface DeadLetterStore {
  add(letter: NewDeadLetter): Promise<StoredDeadLetter>;
  get(id: string): Promise<StoredDeadLetter | null>;
  /**
   * The letters that match, oldest `firstFailedAt` first, then by `id`, so a page is the same on
   * every store.
   */
  list(args?: ListDeadLettersArgs): Promise<readonly StoredDeadLetter[]>;
  count(args?: ListDeadLettersArgs): Promise<number>;
  /**
   * The `failed` letters whose `person` and `errorCode` are these, in the order of `list`: what
   * lifting a person's restriction retries.
   */
  listFailed(args: ListFailedDeadLettersArgs): Promise<readonly StoredDeadLetter[]>;
  /**
   * Moves a `failed` letter to `status`, resolved at `at`. Rejects with `DeadLetterSettledError`
   * when the letter is missing or no longer `failed`, so of two retries or discards of one letter
   * only the first changes it.
   */
  updateStatus(id: string, status: DeadLetterStatus, at: Date): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * Every letter that names `person`, in `person` or in `persons`, whatever its status, in the
   * order of `list`.
   */
  listByPerson(person: string): Promise<readonly StoredDeadLetter[]>;
  /**
   * Removes every letter whose `persons` names `person`, whatever its status, and resolves to them
   * in the order of `list`. A letter that names the person only in `person` stays.
   */
  forget(person: string): Promise<readonly StoredDeadLetter[]>;
  /**
   * The earliest `resolvedAt` of the letters held, `null` when none is resolved.
   */
  firstResolvedAt(): Promise<Date | null>;
  /**
   * Removes the resolved letters `args` names, earliest `resolvedAt` first, and resolves to how
   * many it removed. A `failed` letter always stays.
   */
  purge(args: PurgeDeadLettersArgs): Promise<number>;
}
