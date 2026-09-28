import type {
  DeadLetterErrorType,
  DeadLetterStore,
} from "../../adapter/ports/dead-letter-store.ts";
import type { InboxLedger } from "../../adapter/ports/inbox-ledger.ts";
import type { Scheduler } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig, ResolvedPoliciesConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import { deriveDeadLetterId } from "../shared/idempotency-key.ts";
import { deliverInOrder, type ReactionOutcome } from "../shared/in-order.ts";
import { runClaimed } from "../shared/inbox-claim.ts";
import { errorDetails } from "../shared/retry.ts";
import { deadLettered } from "../telemetry.ts";
import type { PoliciesRuntime, PolicyRuntime } from "./build-policies.ts";
import { scheduleDelayedPolicy } from "./delayed.ts";
import type { PolicyExecutor } from "./executor.ts";

export const POLICIES_SUBSCRIBER: "policies" = "policies";

export interface CreatePolicySubscriberArgs {
  readonly policies: PoliciesRuntime;
  readonly executor: PolicyExecutor;
  readonly scheduler: Scheduler;
  readonly ledger: InboxLedger;
  readonly deadLetters: DeadLetterStore;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreatePolicySubscriberFunction {
  (args: CreatePolicySubscriberArgs): Subscriber;
}

/**
 * One subscriber for every policy. For each event and each policy that reacts to it, the runner
 * claims `(policy, eventId)` in the inbox ledger and runs the handler, or, for a delayed policy,
 * schedules its run for the event's time plus the delay. Failures are classified: terminal ones
 * are dead-lettered at once; retriable ones are retried on later passes with the configured
 * back-off, then dead-lettered. While a retry is pending, or while another instance holds the
 * claim, the checkpoint stops right before that event and the policy skips its later events of
 * the batch, so none of them overtakes the held one; other policies carry on.
 */
export const createPolicySubscriber: CreatePolicySubscriberFunction = ({
  policies,
  executor,
  scheduler,
  ledger,
  deadLetters,
  config,
  clock,
  logger,
}) => {
  const deadLetter = async (
    policy: PolicyRuntime,
    event: StoredEvent,
    error: unknown,
    attempts: number,
    errorType: DeadLetterErrorType,
  ): Promise<void> => {
    const id = deriveDeadLetterId({ kind: "policy", handler: policy.name, subject: event.id });
    if ((await deadLetters.get(id)) !== null) return;
    const details = errorDetails(error);
    const now = clock.now().toISOString();
    await deadLetters.add({
      id,
      kind: "policy",
      subscriber: policy.name,
      eventId: event.id,
      eventType: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      errorType,
      errorMessage: details.message,
      ...(details.stack === undefined ? {} : { errorStack: details.stack }),
      attempts,
      firstFailedAt: now,
      lastFailedAt: now,
    });
    deadLettered({ kind: "policy", subscriber: policy.name, errorType });
    logger.warn("policy dead-lettered", {
      policy: policy.name,
      eventId: event.id,
      errorType,
      attempts,
    });
  };

  const run = (
    policy: PolicyRuntime,
    event: StoredEvent,
    settings: ResolvedPoliciesConfig,
  ): Promise<ReactionOutcome> =>
    runClaimed({
      ledger,
      key: { subscriber: policy.name, eventId: event.id },
      retry: settings.retry,
      leaseMs: settings.timeoutMs * 2,
      clock,
      run: async (attempt) => {
        if (policy.delayMs === null) {
          await executor.run({ policy, event, attempt });
        } else {
          await scheduleDelayedPolicy({ scheduler, policy, delayMs: policy.delayMs, event });
        }
      },
      giveUp: (error, attempts, errorType) => deadLetter(policy, event, error, attempts, errorType),
      willRetry: (attempts) => {
        logger.warn("policy failed; will retry", {
          policy: policy.name,
          eventId: event.id,
          attempts,
        });
      },
    });

  return {
    name: POLICIES_SUBSCRIBER,
    kind: "policy",
    process: (events) =>
      deliverInOrder({
        events,
        byEvent: policies.byEvent,
        deliver: (policy, event) =>
          run(policy, event, config.forAggregate(policy.aggregate).policies),
      }),
  };
};
