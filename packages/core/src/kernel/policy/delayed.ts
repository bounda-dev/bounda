import type { EventStore } from "../../adapter/storage/event-store.ts";
import type { ScheduledCommand, Scheduler } from "../../adapter/storage/scheduler.ts";
import type { ResolvedConfig, ResolvedRetryConfig } from "../../config/types.ts";
import { ConfigurationError, NotFoundError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { UnitOfWork } from "../unit-of-work/unit-of-work.ts";
import type { PoliciesRuntime, PolicyRuntime } from "./build-policies.ts";
import type { PolicyExecutor } from "./executor.ts";

/**
 * The scheduler command type of a delayed policy run. Not a user command.
 */
export const DELAYED_POLICY_COMMAND: "bounda.DelayedPolicy" = "bounda.DelayedPolicy";

/**
 * What the scheduler keeps for a delayed policy run: the policy and where its event is, never the
 * event itself, so the handler reads it upcast to the shape it has when the run comes due.
 */
export interface DelayedPolicyPayload {
  readonly policy: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly position: number;
}

export interface ScheduleDelayedPolicyArgs {
  readonly scheduler: Scheduler;
  readonly policy: PolicyRuntime;
  readonly delayMs: number;
  readonly event: StoredEvent;
}

export interface ScheduleDelayedPolicyFunction {
  (args: ScheduleDelayedPolicyArgs): Promise<void>;
}

/**
 * Keyed by the policy and the event, so delivering the event again schedules the same run.
 */
export const scheduleDelayedPolicy: ScheduleDelayedPolicyFunction = ({
  scheduler,
  policy,
  delayMs,
  event,
}) =>
  scheduler.schedule({
    dedupeKey: `policy:${policy.name}:${event.id}`,
    command: {
      type: DELAYED_POLICY_COMMAND,
      aggregateId: event.aggregateId,
      payload: {
        policy: policy.name,
        eventId: event.id,
        eventType: event.type,
        aggregateType: event.aggregateType,
        position: event.position,
      } satisfies DelayedPolicyPayload,
    },
    executeAt: new Date(new Date(event.timestamp).getTime() + delayMs),
    context: {
      correlationId: event.metadata.correlationId,
      causationId: event.id,
      depth: event.metadata.depth,
    },
  });

/**
 * How the scheduled-command worker runs the delayed policy entries it claims.
 */
export interface DelayedPolicies {
  isDelayedPolicy(entry: ScheduledCommand): boolean;
  /**
   * Runs the policy on `within`, the worker's unit of work for the entry. A policy no longer in
   * the registry or an event that is gone fails for good.
   */
  run(entry: ScheduledCommand, within: UnitOfWork): Promise<void>;
  /**
   * The retry settings of the policy's aggregate, the same a live run of it gets.
   */
  retryOf(entry: ScheduledCommand): ResolvedRetryConfig;
  payloadOf(entry: ScheduledCommand): DelayedPolicyPayload;
}

export interface CreateDelayedPoliciesArgs {
  readonly policies: PoliciesRuntime;
  readonly executor: PolicyExecutor;
  /**
   * The kernel's event store, which upcasts, to read the event with.
   */
  readonly eventStore: EventStore;
  readonly config: ResolvedConfig;
}

export interface CreateDelayedPoliciesFunction {
  (args: CreateDelayedPoliciesArgs): DelayedPolicies;
}

/**
 * The event is read by its global position, one row, through the upcasting event store.
 */
export const createDelayedPolicies: CreateDelayedPoliciesFunction = ({
  policies,
  executor,
  eventStore,
  config,
}) => {
  const payloadOf = (entry: ScheduledCommand): DelayedPolicyPayload =>
    entry.command.payload as DelayedPolicyPayload;

  return {
    isDelayedPolicy: (entry) => entry.command.type === DELAYED_POLICY_COMMAND,
    payloadOf,
    retryOf: (entry) => {
      const policy = policies.byName[payloadOf(entry).policy];
      return policy === undefined
        ? config.runtime.policies.retry
        : config.forAggregate(policy.aggregate).policies.retry;
    },
    run: async (entry, within) => {
      const payload = payloadOf(entry);
      const policy = policies.byName[payload.policy];
      if (policy === undefined) {
        throw new ConfigurationError(`Policy "${payload.policy}" is no longer in the registry`);
      }
      const [event] = await eventStore.readAll({
        afterPosition: payload.position - 1,
        limit: 1,
      });
      if (event === undefined || event.id !== payload.eventId) {
        throw new NotFoundError(
          `Event ${payload.eventId} of ${payload.aggregateType}:${entry.command.aggregateId} not found`,
        );
      }
      await executor.run({ policy, event, attempt: entry.attempts + 1, within });
    },
  };
};
