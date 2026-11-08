import type { DeadLetterErrorType } from "../../adapter/storage/dead-letter-store.ts";
import type { ResolvedConfig, ResolvedPoliciesConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import { sealError } from "../personal-data/errors.ts";
import { openedUnder } from "../personal-data/event-store.ts";
import { personOfEvent } from "../personal-data/persons.ts";
import { restrictedPersonOf } from "../personal-data/refusal.ts";
import { deriveDeadLetterId } from "../shared/idempotency-key.ts";
import { deliverInOrder, type ReactionOutcome } from "../shared/in-order.ts";
import type { PendingRetries } from "../shared/pending-retries.ts";
import { runAttempt } from "../shared/reaction-attempt.ts";
import { deadLettered } from "../telemetry.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { PoliciesRuntime, PolicyRuntime } from "./build-policies.ts";
import { scheduleDelayedPolicy } from "./delayed.ts";
import type { PolicyExecutor } from "./executor.ts";

export const POLICIES_SUBSCRIBER: "policies" = "policies";

export interface CreatePolicySubscriberArgs {
  readonly policies: PoliciesRuntime;
  readonly aggregates: AggregatesRuntime;
  readonly executor: PolicyExecutor;
  readonly storage: AppStorage;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly pendingRetries: PendingRetries;
  readonly logger: Logger;
}

export interface CreatePolicySubscriberFunction {
  (args: CreatePolicySubscriberArgs): Subscriber;
}

const letterIdOf = (policy: PolicyRuntime, event: StoredEvent): string =>
  deriveDeadLetterId({ kind: "policy", handler: policy.name, subject: event.id });

/**
 * One subscriber for every policy. A policy that holds an event, for a pending retry or a claim
 * another instance has, is handed none of its later events of the batch; other policies carry on.
 */
export const createPolicySubscriber: CreatePolicySubscriberFunction = ({
  policies,
  aggregates,
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
    const id = letterIdOf(policy, event);
    const person = restrictedPersonOf(error) ?? personOfEvent({ aggregates, event });
    const now = clock.now().toISOString();
    await unit.deadLetterStore.add({
      id,
      kind: "policy",
      handler: policy.name,
      eventId: event.id,
      eventType: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      person,
      errorType,
      ...(await sealError({ error, person, keys: storage.personalKeys, read: openedUnder(event) })),
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
    error: unknown,
  ): void => {
    deadLettered({ kind: "policy", handler: policy.name, errorType });
    logger.warn("policy dead-lettered", {
      policy: policy.name,
      eventId: event.id,
      letterId: letterIdOf(policy, event),
      errorType,
      attempts,
      error,
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
      gaveUp: (attempts, errorType, error) => gaveUp(policy, event, attempts, errorType, error),
      willRetry: (attempts, error) => {
        logger.warn("policy failed; will retry", {
          policy: policy.name,
          eventId: event.id,
          attempts,
          error,
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
