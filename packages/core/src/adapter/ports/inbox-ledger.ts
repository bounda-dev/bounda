import type { DeadLetterErrorType } from "./dead-letter-store.ts";

export type ClaimStatus = "pending" | "succeeded" | "failed";

export interface ClaimArgs {
  readonly subscriber: string;
  readonly eventId: string;
  /**
   * The kernel clock's time, which leases are measured against.
   */
  readonly now: Date;
  /**
   * How long a `pending` claim stays owned; an older one was abandoned by a crashed instance and
   * can be claimed again.
   */
  readonly leaseMs: number;
}

export interface ClaimKey {
  readonly subscriber: string;
  readonly eventId: string;
}

export interface FailClaimArgs extends ClaimKey {
  readonly error: string;
  /**
   * Set when the runner gives up on the event, before it writes the dead letter, so whoever claims
   * it next writes the letter instead of running the handler again. A `fail` without it clears it.
   */
  readonly gaveUp?: DeadLetterErrorType | undefined;
}

export interface ClaimRecord extends ClaimKey {
  readonly status: ClaimStatus;
  readonly attempts: number;
  readonly claimedAt: string;
  readonly lastError?: string;
  /**
   * As the last `fail` set it; kept across `tryClaim`.
   */
  readonly gaveUp?: DeadLetterErrorType;
}

/**
 * Gives at-least-once delivery its idempotency: a policy or process handler runs for an event only
 * once the runner claims `(subscriber, eventId)`. `tryClaim` must be atomic: of two racing
 * claimers exactly one gets `true`. A `succeeded` claim is never handed out again, a `failed` one
 * is, a `pending` one only once its lease expires. Claiming again counts an attempt and keeps
 * `lastError` and `gaveUp`.
 */
export interface InboxLedger {
  tryClaim(args: ClaimArgs): Promise<boolean>;
  complete(key: ClaimKey): Promise<void>;
  fail(args: FailClaimArgs): Promise<void>;
  get(key: ClaimKey): Promise<ClaimRecord | null>;
}
