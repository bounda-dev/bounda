import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import { createReactionCommands } from "../command/reaction-commands.ts";
import { openedUnder } from "../personal-data/event-store.ts";
import { actedBy, causedBy } from "../shared/causation.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { withTimeout } from "../shared/timeout.ts";
import { withPorts } from "../shared/with-ports.ts";
import { ATTRIBUTES, actorAttribute, traced } from "../telemetry.ts";
import type { UnitStores } from "../unit-of-work/unit-of-work.ts";
import type { PolicyRuntime } from "./build-policies.ts";

export interface RunPolicyArgs {
  readonly policy: PolicyRuntime;
  readonly event: StoredEvent;
  /**
   * Which run this is for the event, counting the failed ones before it.
   */
  readonly attempt: number;
  /**
   * Set when an operator retries a dead letter, so the handler gets a new idempotency key.
   */
  readonly retryId?: string | undefined;
  /**
   * Who retries the dead letter, who then acts in place of the event's actor.
   */
  readonly actor?: string | undefined;
  /**
   * The unit of work the run's commands write to, to commit with the attempt.
   */
  readonly within: UnitStores;
}

/**
 * The live subscriber, the worker running a delayed policy and a dead-letter retry all run
 * policies through it, so the handler always gets the same arguments, time budget and trace.
 */
export interface PolicyExecutor {
  run(args: RunPolicyArgs): Promise<void>;
}

export interface CreatePolicyExecutorArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreatePolicyExecutorFunction {
  (args: CreatePolicyExecutorArgs): PolicyExecutor;
}

export const createPolicyExecutor: CreatePolicyExecutorFunction = ({
  aggregates,
  pipeline,
  config,
  ids,
  clock,
  logger,
}) => ({
  run: async ({ policy, event, attempt, retryId, actor, within }) => {
    within.read(openedUnder(event));
    const idempotencyKey = deriveIdempotencyKey({
      kind: "policy",
      handler: policy.name,
      subject: event.id,
      retryId,
    });
    const context = { ...causedBy(event), ...actedBy(actor) };
    const reaction = createReactionCommands({
      aggregates,
      pipeline,
      context,
      idempotencyKey,
      within,
      logger,
      ids,
      clock,
      maxChainDepth: config.forAggregate(policy.aggregate).policies.maxChainDepth,
    });
    const handled = traced({
      errorText: config.runtime.telemetry.errorText,
      name: `bounda.policy ${policy.name}`,
      attributes: {
        [ATTRIBUTES.policy]: policy.name,
        [ATTRIBUTES.eventId]: event.id,
        [ATTRIBUTES.eventType]: event.type,
        [ATTRIBUTES.aggregateType]: event.aggregateType,
        [ATTRIBUTES.aggregateId]: event.aggregateId,
        [ATTRIBUTES.correlationId]: event.metadata.correlationId,
        [ATTRIBUTES.attempt]: attempt,
        ...actorAttribute(context.actor),
      },
      run: async () => {
        await withTimeout({
          run: async () => {
            await policy.handler(
              withPorts(policy.ports, {
                event,
                commands: reaction.commands,
                idempotencyKey,
                signal: reaction.signal,
                forget: reaction.forget,
              }),
            );
            await reaction.decided();
          },
          timeoutMs: config.forAggregate(policy.aggregate).policies.timeoutMs,
          subject: `policy ${policy.name}`,
          clock,
        });
      },
    });
    try {
      await handled;
    } catch (error) {
      reaction.abandon(error);
      throw error;
    }
  },
});
