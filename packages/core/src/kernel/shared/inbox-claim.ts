import type { ClaimKey, InboxLedger } from "../../adapter/ports/inbox-ledger.ts";
import type { ResolvedRetryConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { ReactionOutcome } from "./in-order.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "./retry.ts";

export type GiveUpType = "terminal" | "retriable_exhausted";

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
   * right after, so the event is never handed out again.
   */
  readonly giveUp: (error: unknown, attempts: number, errorType: GiveUpType) => Promise<void>;
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
 * both as `hold`. A terminal failure, or a retriable one past `retry.maxAttempts`, is given up
 * on and completes the claim; any other retriable failure fails it and holds the event for a
 * later attempt.
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
    if (classifyFailure(error) === "terminal") {
      await giveUp(error, attempts, "terminal");
      await ledger.complete(key);
      return "done";
    }
    await ledger.fail({ ...key, error: errorDetails(error).message });
    if (attempts >= retry.maxAttempts || retry.strategy === "none") {
      await giveUp(error, attempts, "retriable_exhausted");
      await ledger.complete(key);
      return "done";
    }
    willRetry(attempts);
    return "hold";
  }
};
