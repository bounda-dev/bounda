import type { Scheduler } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import { createReactionCommands } from "../command/reaction-commands.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { withTimeout } from "../shared/timeout.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";
import type { PolicyRuntime } from "./build-policies.ts";

export interface RunPolicyArgs {
  readonly policy: PolicyRuntime;
  readonly event: StoredEvent;
  /**
   * Which run this is for the event, counting the failed ones before it.
   */
  readonly attempt: number;
  /**
   * Set when an operator replays a dead letter, so the handler gets a new idempotency key.
   */
  readonly replay?: string | undefined;
}

/**
 * Runs a policy's handler for one event. The live subscriber, the worker running a delayed
 * policy and a dead-letter replay all go through it, so the handler always gets the same
 * arguments, time budget and trace.
 */
export interface PolicyExecutor {
  run(args: RunPolicyArgs): Promise<void>;
}

export interface CreatePolicyExecutorArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly scheduler: Scheduler;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
}

export interface CreatePolicyExecutorFunction {
  (args: CreatePolicyExecutorArgs): PolicyExecutor;
}

export const createPolicyExecutor: CreatePolicyExecutorFunction = ({
  aggregates,
  pipeline,
  scheduler,
  config,
  clock,
}) => ({
  run: async ({ policy, event, attempt, replay }) => {
    const idempotencyKey = deriveIdempotencyKey({
      kind: "policy",
      handler: policy.name,
      subject: event.id,
      replay,
    });
    const reaction = createReactionCommands({
      aggregates,
      pipeline,
      scheduler,
      context: {
        correlationId: event.metadata.correlationId,
        causationId: event.id,
        depth: event.metadata.depth,
      },
      idempotencyKey,
    });
    const handled = traced({
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
      run: async () => {
        await withTimeout({
          run: () =>
            policy.handler({
              ...policy.collaborators,
              event,
              commands: reaction.commands,
              idempotencyKey,
              signal: reaction.signal,
            }),
          timeoutMs: config.forAggregate(policy.aggregate).policies.timeoutMs,
          subject: `policy ${policy.name}`,
          clock,
        });
      },
    });
    try {
      await handled;
    } catch (error) {
      await reaction.abandon(error);
      throw error;
    }
  },
});
