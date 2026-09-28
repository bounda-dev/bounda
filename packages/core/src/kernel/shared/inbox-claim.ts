import type { DeadLetterErrorType } from "../../adapter/ports/dead-letter-store.ts";
import type { ClaimKey, InboxLedger } from "../../adapter/ports/inbox-ledger.ts";
import type { ResolvedRetryConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { ReactionOutcome } from "./in-order.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "./retry.ts";

export interface RunClaimedArgs {
  readonly ledger: InboxLedger;
  readonly key: ClaimKey;
  readonly retry: ResolvedRetryConfig;
  readonly leaseMs: number;
  readonly clock: Clock;
  /**
   * The reaction itself; `attempt` counts from 1 across retries.
   */
  readonly run: (attempt: number) => Promise<void>;
  /**
   * Records a failure the reaction gives up on, typically as a dead letter. The claim is completed
   * right after, so the event is never handed out again. The claim records the give-up first, so
   * when this throws the next delivery gives up again without running the reaction; `error` is
   * then the message the ledger kept.
   */
  readonly giveUp: (
    error: unknown,
    attempts: number,
    errorType: DeadLetterErrorType,
  ) => Promise<void>;
  /**
   * Called when a retriable failure will be retried on a later delivery.
   */
  readonly willRetry: (attempts: number) => void;
}

export interface RunClaimedFunction {
  (args: RunClaimedArgs): Promise<ReactionOutcome>;
}

/**
 * Runs a reaction to one event at most once through the inbox ledger. A claim already succeeded
 * is `done`; one that failed waits out its back-off, and one another holder owns is left to it,
 * both as `hold`. A terminal failure, or a retriable one on the last of `retry.maxAttempts`, is
 * given up on: the claim records it, the failure is recorded with `giveUp`, and the claim is
 * completed. Any other retriable failure fails the claim and holds the event for a later attempt.
 * A claim that records a give-up is given up on again, without running the reaction, until
 * `giveUp` gets through.
 */
export const runClaimed: RunClaimedFunction = async ({
  ledger,
  key,
  retry,
  leaseMs,
  clock,
  run,
  giveUp,
  willRetry,
}) => {
  const now = clock.now();
  const existing = await ledger.get(key);
  if (existing?.status === "succeeded") return "done";
  if (existing?.gaveUp !== undefined) {
    if (!(await ledger.tryClaim({ ...key, now, leaseMs }))) return "hold";
    await giveUp(
      existing.lastError ?? `gave up after ${existing.attempts} attempts`,
      existing.attempts,
      existing.gaveUp,
    );
    await ledger.complete(key);
    return "done";
  }
  if (existing?.status === "failed") {
    const waitMs = retryDelayMs({ retry, attempt: existing.attempts });
    if (now.getTime() - new Date(existing.claimedAt).getTime() < waitMs) return "hold";
  }
  if (!(await ledger.tryClaim({ ...key, now, leaseMs }))) return "hold";
  const attempts = (existing?.attempts ?? 0) + 1;
  try {
    await run(attempts);
    await ledger.complete(key);
    return "done";
  } catch (error) {
    const gaveUp: DeadLetterErrorType | undefined =
      classifyFailure(error) === "terminal"
        ? "terminal"
        : attempts >= retry.maxAttempts || retry.strategy === "none"
          ? "retriable_exhausted"
          : undefined;
    const message = errorDetails(error).message;
    await ledger.fail({ ...key, error: message, gaveUp });
    if (gaveUp === undefined) {
      willRetry(attempts);
      return "hold";
    }
    await giveUp(error, attempts, gaveUp);
    await ledger.complete(key);
    return "done";
  }
};
