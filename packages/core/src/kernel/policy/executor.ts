import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { createCommandsFacade } from "../command/facade.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import { createReactionCommandIds, deriveIdempotencyKey } from "../shared/idempotency-key.ts";
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
  readonly config: ResolvedConfig;
  readonly clock: Clock;
}

export interface CreatePolicyExecutorFunction {
  (args: CreatePolicyExecutorArgs): PolicyExecutor;
}

/**
 * The handler receives its collaborators, the event, a commands facade that dispatches one causal
 * hop deeper with ids derived from the run, and the run's idempotency key. It has the aggregate's
 * policy timeout to finish.
 */
export const createPolicyExecutor: CreatePolicyExecutorFunction = ({
  aggregates,
  pipeline,
  config,
  clock,
}) => ({
  run: ({ policy, event, attempt, replay }) => {
    const idempotencyKey = deriveIdempotencyKey({
      kind: "policy",
      handler: policy.name,
      subject: event.id,
      replay,
    });
    const commands = createCommandsFacade({
      aggregates,
      pipeline,
      context: {
        correlationId: event.metadata.correlationId,
        causationId: event.id,
        depth: event.metadata.depth,
      },
      commandIds: createReactionCommandIds(idempotencyKey),
    });
    return traced({
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
          run: () => policy.handler({ ...policy.collaborators, event, commands, idempotencyKey }),
          timeoutMs: config.forAggregate(policy.aggregate).policies.timeoutMs,
          subject: `policy ${policy.name}`,
          clock,
        });
      },
    });
  },
});
