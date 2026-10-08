import type { StoragePorts } from "../../adapter/adapter.ts";
import type { DeadLetterErrorType } from "../../adapter/ports/dead-letter-store.ts";
import type { ResolvedConfig, ResolvedPoliciesConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import { deriveDeadLetterId } from "../shared/idempotency-key.ts";
import { deliverInOrder, type ReactionOutcome } from "../shared/in-order.ts";
import type { PendingRetries } from "../shared/pending-retries.ts";
import { runAttempt } from "../shared/reaction-attempt.ts";
import { errorDetails } from "../shared/retry.ts";
import { deadLettered } from "../telemetry.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { PoliciesRuntime, PolicyRuntime } from "./build-policies.ts";
import { scheduleDelayedPolicy } from "./delayed.ts";
import type { PolicyExecutor } from "./executor.ts";

export const POLICIES_SUBSCRIBER: "policies" = "policies";

export interface CreatePolicySubscriberArgs {
  readonly policies: PoliciesRuntime;
  readonly executor: PolicyExecutor;
  readonly storage: StoragePorts;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly pendingRetries: PendingRetries;
  readonly logger: Logger;
}

export interface CreatePolicySubscriberFunction {
  (args: CreatePolicySubscriberArgs): Subscriber;
}

/**
 * One subscriber for every policy. A policy that holds an event, for a pending retry or a claim
 * another instance has, is handed none of its later events of the batch; other policies carry on.
 */
export const createPolicySubscriber: CreatePolicySubscriberFunction = ({
  policies,
  executor,
  storage,
  config,
  clock,
  pendingRetries,
  logger,
}) => {
  const deadLetter = async (
    unit: UnitOfWork,
    policy: PolicyRuntime,
    event: StoredEvent,
    error: unknown,
    attempts: number,
    errorType: DeadLetterErrorType,
  ): Promise<void> => {
    const id = deriveDeadLetterId({ kind: "policy", handler: policy.name, subject: event.id });
    const details = errorDetails(error);
    const now = clock.now().toISOString();
    await unit.deadLetterStore.add({
      id,
      kind: "policy",
      handler: policy.name,
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
  };

  const gaveUp = (
    policy: PolicyRuntime,
    event: StoredEvent,
    attempts: number,
    errorType: DeadLetterErrorType,
  ): void => {
    deadLettered({ kind: "policy", handler: policy.name, errorType });
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
    runAttempt({
      storage,
      key: { handler: policy.name, eventId: event.id },
      retry: settings.retry,
      leaseMs: settings.timeoutMs * 2,
      concurrencyRetries: config.runtime.commands.concurrencyRetries,
      clock,
      pendingRetries,
      run: async (unit, attempt) => {
        if (policy.delayMs === null) {
          await executor.run({ policy, event, attempt, within: unit });
        } else {
          await scheduleDelayedPolicy({
            scheduler: unit.scheduler,
            policy,
            delayMs: policy.delayMs,
            event,
          });
        }
      },
      giveUp: (unit, error, attempts, errorType) =>
        deadLetter(unit, policy, event, error, attempts, errorType),
      gaveUp: (attempts, errorType) => gaveUp(policy, event, attempts, errorType),
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
