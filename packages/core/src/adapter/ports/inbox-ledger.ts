export type ClaimStatus = "pending" | "succeeded" | "failed";

export interface ClaimArgs {
  readonly subscriber: string;
  readonly eventId: string;
  /**
   * Current time, supplied by the kernel's clock.
   */
  readonly now: Date;
  /**
   * How long a `pending` claim stays owned. A pending claim older than this is considered
   * abandoned by a crashed instance and can be claimed again.
   */
  readonly leaseMs: number;
}

export interface ClaimKey {
  readonly subscriber: string;
  readonly eventId: string;
}

export interface FailClaimArgs extends ClaimKey {
  readonly error: string;
}

export interface ClaimRecord extends ClaimKey {
  readonly status: ClaimStatus;
  readonly attempts: number;
  readonly claimedAt: string;
  readonly lastError?: string;
}

/**
 * Gives at-least-once delivery its idempotency. Before a policy or process handler runs for an
 * event, the runner claims `(subscriber, eventId)`. The claim must be atomic: with two instances
 * racing, exactly one gets `true`. `succeeded` claims are never handed out again; `failed` ones
 * are, so the runner can retry; `pending` ones only once their lease expires.
 */
export interface InboxLedger {
  tryClaim(args: ClaimArgs): Promise<boolean>;
  complete(key: ClaimKey): Promise<void>;
  fail(args: FailClaimArgs): Promise<void>;
  get(key: ClaimKey): Promise<ClaimRecord | null>;
}
