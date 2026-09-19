export type DeadLetterKind = "policy" | "process" | "projection" | "command";

export type DeadLetterErrorType = "terminal" | "retriable_exhausted";

export type DeadLetterStatus = "failed" | "replayed" | "discarded";

/**
 * A handler execution that gave up: which subscriber, which event, why, and how many times it was
 * tried.
 */
export interface DeadLetter {
  readonly id: string;
  readonly kind: DeadLetterKind;
  readonly subscriber: string;
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
}

export type NewDeadLetter = Omit<DeadLetter, "status">;

export interface ListDeadLettersArgs {
  readonly kind?: DeadLetterKind;
  readonly subscriber?: string;
  readonly status?: DeadLetterStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Storage for dead letters. `add` is idempotent on `id`.
 */
export interface DeadLetterStore {
  add(letter: NewDeadLetter): Promise<DeadLetter>;
  get(id: string): Promise<DeadLetter | null>;
  list(args?: ListDeadLettersArgs): Promise<readonly DeadLetter[]>;
  count(args?: ListDeadLettersArgs): Promise<number>;
  updateStatus(id: string, status: DeadLetterStatus): Promise<void>;
  remove(id: string): Promise<void>;
}
