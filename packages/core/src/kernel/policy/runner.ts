import type { DeadLetterStore } from "../../adapter/ports/dead-letter-store.ts";
import type { InboxLedger } from "../../adapter/ports/inbox-ledger.ts";
import type { ResolvedConfig, ResolvedPoliciesConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { createCommandsFacade } from "../command/facade.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import { classifyFailure, errorDetails, retryDelayMs } from "../shared/retry.ts";
import { withTimeout } from "../shared/timeout.ts";
import { ATTRIBUTES, deadLettered, traced } from "../telemetry.ts";
import type { PoliciesRuntime, PolicyRuntime } from "./build-policies.ts";

export const POLICIES_SUBSCRIBER: "policies" = "policies";

export interface CreatePolicySubscriberArgs {
  readonly policies: PoliciesRuntime;
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly ledger: InboxLedger;
  readonly deadLetters: DeadLetterStore;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreatePolicySubscriberFunction {
  (args: CreatePolicySubscriberArgs): Subscriber;
}

type Outcome = "done" | "hold";

/**
 * One subscriber for every policy. For each event and each policy that reacts to it, the runner
 * claims `(policy, eventId)` in the inbox ledger and runs the handler with a commands facade
 * carrying the event's causal context. Failures are classified: terminal ones are dead-lettered
 * at once; retriable ones are retried on later passes with the configured back-off, then
 * dead-lettered. While a retry is pending the checkpoint holds, so events stay ordered.
 */
export const createPolicySubscriber: CreatePolicySubscriberFunction = ({
  policies,
  aggregates,
  pipeline,
  ledger,
  deadLetters,
  config,
  ids,
  clock,
  logger,
}) => {
  const deadLetter = async (
    policy: PolicyRuntime,
    event: StoredEvent,
    error: unknown,
    attempts: number,
    errorType: "terminal" | "retriable_exhausted",
  ): Promise<void> => {
    const details = errorDetails(error);
    const now = clock.now().toISOString();
    await deadLetters.add({
      id: ids.next(),
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
    await ledger.complete({ subscriber: policy.name, eventId: event.id });
    deadLettered({ kind: "policy", subscriber: policy.name, errorType });
    logger.warn("policy dead-lettered", {
      policy: policy.name,
      eventId: event.id,
      errorType,
      attempts,
    });
  };

  const run = async (
    policy: PolicyRuntime,
    event: StoredEvent,
    settings: ResolvedPoliciesConfig,
  ): Promise<Outcome> => {
    const key = { subscriber: policy.name, eventId: event.id };
    const now = clock.now();
    const existing = await ledger.get(key);
    if (existing?.status === "succeeded") return "done";
    if (existing?.status === "failed") {
      const waitMs = retryDelayMs({ retry: settings.retry, attempt: existing.attempts });
      if (now.getTime() - new Date(existing.claimedAt).getTime() < waitMs) return "hold";
    }
    const claimed = await ledger.tryClaim({ ...key, now, leaseMs: settings.timeoutMs * 2 });
    if (!claimed) return "hold";

    const commands = createCommandsFacade({
      aggregates,
      pipeline,
      context: {
        correlationId: event.metadata.correlationId,
        causationId: event.id,
        depth: event.metadata.depth,
      },
    });
    const attempt = (existing?.attempts ?? 0) + 1;
    try {
      await traced({
        name: `bounda.policy ${policy.name}`,
        attributes: {
          [ATTRIBUTES.policy]: policy.name,
          [ATTRIBUTES.eventId]: event.id,
          [ATTRIBUTES.eventType]: event.type,
          [ATTRIBUTES.aggregateType]: event.aggregateType,
          [ATTRIBUTES.aggregateId]: event.aggregateId,
          [ATTRIBUTES.correlationId]: event.metadata.correlationId,
          [ATTRIBUTES.attempt]: attempt,
        },
        run: () =>
          withTimeout({
            run: () => policy.handler({ ...policy.collaborators, event, commands }),
            timeoutMs: settings.timeoutMs,
            subject: `policy ${policy.name}`,
            clock,
          }),
      });
      await ledger.complete(key);
      return "done";
    } catch (error) {
      const attempts = attempt;
      if (classifyFailure(error) === "terminal") {
        await deadLetter(policy, event, error, attempts, "terminal");
        return "done";
      }
      await ledger.fail({ ...key, error: errorDetails(error).message });
      if (attempts >= settings.retry.maxAttempts || settings.retry.strategy === "none") {
        await deadLetter(policy, event, error, attempts, "retriable_exhausted");
        return "done";
      }
      logger.warn("policy failed; will retry", {
        policy: policy.name,
        eventId: event.id,
        attempts,
      });
      return "hold";
    }
  };

  return {
    name: POLICIES_SUBSCRIBER,
    kind: "policy",
    process: async (events) => {
      let hold = false;
      for (const event of events) {
        for (const policy of policies.byEvent[event.type] ?? []) {
          const outcome = await run(policy, event, config.forAggregate(policy.aggregate).policies);
          hold = hold || outcome === "hold";
        }
      }
      return !hold;
    },
  };
};
