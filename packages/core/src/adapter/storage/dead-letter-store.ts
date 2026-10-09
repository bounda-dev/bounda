/**
 * What gave up: a policy or process handler (a delayed policy run included), or a scheduled
 * command, one dispatched with `delay`.
 */
export type DeadLetterKind = "policy" | "process" | "scheduled";

export type DeadLetterErrorType = "terminal" | "retriable_exhausted";

export type DeadLetterStatus = "failed" | "retried" | "discarded";

/**
 * A handler run that gave up. `status` is `failed` until an operator retries or discards it.
 */
export interface DeadLetter {
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
  readonly errorType: DeadLetterErrorType;
  readonly errorMessage: string;
  readonly errorStack?: string;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly status: DeadLetterStatus;
  /**
   * Only on `scheduled` letters: the dropped command's payload, to dispatch it again.
   * Policy and process letters point at a stored event instead.
   */
  readonly payload?: unknown;
  /**
   * Process letters only: how many steps wait on the instance. While the letter is `failed`, the
   * events parked behind it for its retry to handle; on the letter a retry returns, the steps
   * still waiting because the process failed again, the one it failed on included, so `0` there
   * means the instance resumed, or, for a follow-up of a timed-out instance, that nothing waits.
   * Filled in by `app.deadLetters`, never stored.
   */
  readonly parked?: number;
}

export type NewDeadLetter = Omit<DeadLetter, "status" | "parked">;

export interface ListDeadLettersArgs {
  readonly kind?: DeadLetterKind;
  readonly handler?: string;
  readonly status?: DeadLetterStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * `add` stores a letter as `failed` and resolves to what is stored; adding an `id` again keeps
 * the first letter.
 */
export interface DeadLetterStore {
  add(letter: NewDeadLetter): Promise<DeadLetter>;
  get(id: string): Promise<DeadLetter | null>;
  /**
   * The letters that match, oldest `firstFailedAt` first, then by `id`, so a page is the same on
   * every store.
   */
  list(args?: ListDeadLettersArgs): Promise<readonly DeadLetter[]>;
  count(args?: ListDeadLettersArgs): Promise<number>;
  /**
   * Moves a `failed` letter to `status`. Rejects with `DeadLetterSettledError` when the letter is
   * missing or no longer `failed`, so of two retries or discards of one letter only the first
   * changes it.
   */
  updateStatus(id: string, status: DeadLetterStatus): Promise<void>;
  remove(id: string): Promise<void>;
}
