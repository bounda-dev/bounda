import type { PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import { createReactionCommands } from "../command/reaction-commands.ts";
import { type RecordAccess, recorded } from "../personal-data/access.ts";
import type { PersonalCategories } from "../personal-data/categories.ts";
import { openedUnder, withoutRetained } from "../personal-data/event-store.ts";
import type { ForgetIntentions } from "../personal-data/intention.ts";
import { personTouchedByEvent } from "../personal-data/persons.ts";
import { refuseRestrictedRead } from "../personal-data/refusal.ts";
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
  readonly personalCategories: PersonalCategories;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intentions: ForgetIntentions;
  /**
   * The keys a run on restricted data reads the categories of.
   */
  readonly keys: Pick<PersonalKeyStore, "find">;
  readonly recordAccess: RecordAccess;
}

export interface CreatePolicyExecutorFunction {
  (args: CreatePolicyExecutorArgs): PolicyExecutor;
}

export const createPolicyExecutor: CreatePolicyExecutorFunction = ({
  personalCategories,
  aggregates,
  pipeline,
  config,
  ids,
  clock,
  logger,
  intentions,
  keys,
  recordAccess,
}) => ({
  run: async ({ policy, event: delivered, attempt, retryId, actor, within }) => {
    // What a forgetting kept reads as `null` to a policy that declares no basis for it.
    const event = policy.restricted === null ? withoutRetained(delivered) : delivered;
    within.read(openedUnder(event));
    // The runtime's own events name no person and carry ids alone: telling those the data went to
    // of a restriction or a forgetting is what a policy on them is for.
    const person = personTouchedByEvent({ aggregates, event });
    const letThrough = await refuseRestrictedRead({
      persons: within.persons,
      keys,
      opened: openedUnder(event),
      touches: person === null ? [] : [person],
      basis: policy.restricted ?? undefined,
    });
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
      personalCategories,
      batchSize: config.runtime.dispatcher.batchSize,
      intentions,
      maxChainDepth: config.forAggregate(policy.aggregate).policies.maxChainDepth,
      restricted: policy.restricted,
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
    const basis = policy.restricted;
    try {
      await (basis === null || letThrough.length === 0
        ? handled
        : recorded(
            (outcome) =>
              recordAccess({
                operation: "policy",
                detail: { handler: policy.name },
                actor: context.actor,
                persons: letThrough,
                outcome,
                restricted: { basis, persons: letThrough },
              }),
            () => handled,
          ));
    } catch (error) {
      reaction.abandon(error);
      throw error;
    }
  },
});
