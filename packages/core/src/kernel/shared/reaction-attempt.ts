import type { Storage } from "../../adapter/adapter.ts";
import type { DeadLetterErrorType } from "../../adapter/storage/dead-letter-store.ts";
import type { ClaimKey } from "../../adapter/storage/inbox-ledger.ts";
import type { ResolvedRetryConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ClaimLostError } from "../../contracts/errors.ts";
import { CommitFailed, commitAttempt, type UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { ReactionOutcome } from "./in-order.ts";
import type { PendingRetries } from "./pending-retries.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "./retry.ts";

export interface RunAttemptArgs {
  readonly storage: Storage;
  readonly key: ClaimKey;
  readonly retry: ResolvedRetryConfig;
  readonly leaseMs: number;
  /**
   * How many times the attempt runs again, on a fresh unit, when its commit finds a stream moved.
   */
  readonly concurrencyRetries: number;
  readonly clock: Clock;
  readonly pendingRetries: PendingRetries;
  /**
   * The reaction itself, writing through `unit`; `attempt` counts from 1 across retries.
   */
  readonly run: (unit: UnitOfWork, attempt: number) => Promise<void>;
  /**
   * Stages what giving up records besides the claim: the dead letter and, for a process, its
   * `ProcessFailed`. Committed together with the claim, or not at all.
   */
  readonly giveUp: (
    unit: UnitOfWork,
    error: unknown,
    attempts: number,
    errorType: DeadLetterErrorType,
  ) => Promise<void>;
  /**
   * Called once the give-up is committed, for what must not be counted for a give-up that rolled
   * back: telemetry and logs.
   */
  readonly gaveUp: (attempts: number, errorType: DeadLetterErrorType) => void;
  /**
   * Called when a retriable failure will be retried on a later delivery.
   */
  readonly willRetry: (attempts: number) => void;
}

export interface RunAttemptFunction {
  (args: RunAttemptArgs): Promise<ReactionOutcome>;
}

/**
 * Runs one attempt of a reaction to one event: claims the event in the inbox, runs the reaction
 * on a unit of work and commits the unit with the claim's completion, or records the failure. A
 * commit that finds a stream moved runs the attempt again on a fresh unit, without spending an
 * attempt; the claim's lease starts again before each rerun, and an attempt whose claim was handed
 * out again meanwhile stops there. Once the reruns are spent the conflict is a retriable failure.
 * A failure of the reaction spends an attempt and holds the event for its back-off, until the
 * attempts run out or the failure is terminal, when the give-up is committed with the claim. A
 * commit or a renewal that fails for any other reason is thrown as it is: the claim stays pending
 * until its lease expires.
 */
export const runAttempt: RunAttemptFunction = async ({
  storage,
  key,
  retry,
  leaseMs,
  concurrencyRetries,
  clock,
  pendingRetries,
  run,
  giveUp,
  gaveUp: reportGaveUp,
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
  const existing = await storage.inboxLedger.get(key);
  if (existing?.status === "succeeded") return "done";
  if (existing?.status === "failed") {
    const dueAt = new Date(
      new Date(existing.claimedAt).getTime() + retryDelayMs({ retry, attempt: existing.attempts }),
    );
    if (now < dueAt) {
      pendingRetries.waiting(dueAt);
      return "hold";
    }
  }
  const claimId = await storage.inboxLedger.tryClaim({ ...key, now, leaseMs });
  if (claimId === null) return "hold";
  const claim = { ...key, claimId };
  const committed = (work: (unit: UnitOfWork) => Promise<void>): Promise<void> =>
    commitAttempt({
      storage,
      concurrencyRetries,
      work,
      // A renewal that failed is the store's failure, not the reaction's; `lost` still tells a
      // claim handed out again.
      beforeRerun: () =>
        storage.inboxLedger.renew({ ...claim, now: clock.now() }).catch((error: unknown) => {
          throw new CommitFailed(error);
        }),
    });
  // The claim was handed out again while this attempt ran: whoever holds it now decides, and
  // nothing of this attempt is written.
  const lost = (error: unknown): boolean =>
    error instanceof ClaimLostError ||
    (error instanceof CommitFailed && error.cause instanceof ClaimLostError);
  const attempts = (existing?.attempts ?? 0) + 1;
  try {
    await committed(async (unit) => {
      await run(unit, attempts);
      await unit.inboxLedger.complete(claim);
    });
    return "done";
  } catch (error) {
    if (lost(error)) return "hold";
    if (error instanceof CommitFailed) throw error.cause;
    const gaveUp = gaveUpOn(error, attempts);
    const message = errorDetails(error).message;
    try {
      if (gaveUp === undefined) {
        await storage.inboxLedger.fail({ ...claim, error: message });
        pendingRetries.waiting(
          new Date(now.getTime() + retryDelayMs({ retry, attempt: attempts })),
        );
        willRetry(attempts);
        return "hold";
      }
      await committed(async (unit) => {
        await giveUp(unit, error, attempts, gaveUp);
        await unit.inboxLedger.fail({ ...claim, error: message });
        await unit.inboxLedger.complete(claim);
      });
    } catch (recording) {
      if (lost(recording)) return "hold";
      throw recording instanceof CommitFailed ? recording.cause : recording;
    }
    reportGaveUp(attempts, gaveUp);
    return "done";
  }
};
