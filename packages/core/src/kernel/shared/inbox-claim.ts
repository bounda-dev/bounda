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
   * Records a failure the reaction gave up on, typically as a dead letter. It can run more than
   * once for one failure, after a crash or an error of its own, so it must be idempotent.
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
 * Runs a reaction to one event through the inbox ledger, retrying retriable failures with
 * back-off. A give-up is written on the claim before `giveUp` runs, so a reaction that gave up is
 * never run again, only given up on again until `giveUp` gets through.
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
  const spent = (attempts: number): boolean =>
    attempts >= retry.maxAttempts || retry.strategy === "none";
  const gaveUpOn = (error: unknown, attempts: number): DeadLetterErrorType | undefined => {
    if (classifyFailure(error) === "terminal") return "terminal";
    if (spent(attempts)) return "retriable_exhausted";
    return undefined;
  };
  const now = clock.now();
  const existing = await ledger.get(key);
  if (existing?.status === "succeeded") return "done";
  if (existing?.status === "failed") {
    const gaveUp =
      existing.gaveUp ?? (spent(existing.attempts) ? "retriable_exhausted" : undefined);
    if (gaveUp !== undefined) {
      await giveUp(
        existing.lastError ?? `gave up after ${existing.attempts} attempts`,
        existing.attempts,
        gaveUp,
      );
      await ledger.complete(key);
      return "done";
    }
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
    const gaveUp = gaveUpOn(error, attempts);
    await ledger.fail({ ...key, error: errorDetails(error).message, gaveUp });
    if (gaveUp === undefined) {
      willRetry(attempts);
      return "hold";
    }
    await giveUp(error, attempts, gaveUp);
    await ledger.complete(key);
    return "done";
  }
};
