import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { ReactionDispatchResult } from "../../contracts/command.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import { createReactionCommands, type ReactionCommands } from "../command/reaction-commands.ts";
import { openedUnder } from "../personal-data/event-store.ts";
import { checkStatePerson } from "../personal-data/process-state.ts";
import { refuseRestricted } from "../personal-data/refusal.ts";
import { actedBy, causedBy } from "../shared/causation.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { isRecord, mergeFields } from "../shared/merge-fields.ts";
import { withTimeout } from "../shared/timeout.ts";
import { withPorts } from "../shared/with-ports.ts";
import { ATTRIBUTES, actorAttribute, traced } from "../telemetry.ts";
import type { UnitStores } from "../unit-of-work/unit-of-work.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { afterFrom, type Deadline } from "./deadlines.ts";
import { instancePersonOf, type ProcessInstance } from "./lifecycle.ts";
import { handlerOf } from "./routes.ts";

export interface RunEventHandlerArgs {
  readonly process: ProcessRuntime;
  readonly event: StoredEvent;
  readonly instanceId: string;
  readonly instance: ProcessInstance;
  readonly attempt: number;
  /**
   * Set when a dead letter is retried, so the handler's `idempotencyKey` differs from the failed
   * run's.
   */
  readonly retryId?: string | undefined;
  /**
   * Who retries the dead letter, who then acts in place of the event's actor.
   */
  readonly actor?: string | undefined;
  /**
   * The unit of work the run's commands write to, to commit with the step that runs it.
   */
  readonly within: UnitStores;
}

export interface RunDeadlineHandlerArgs {
  readonly process: ProcessRuntime;
  readonly instanceId: string;
  readonly instance: ProcessInstance;
  readonly due: Deadline;
  readonly context: CausationContext;
  /**
   * The id the deadline's lifecycle event is written with: what the handler's commands are
   * caused by.
   */
  readonly causationId: string;
  readonly retryId?: string | undefined;
  readonly within: UnitStores;
}

/**
 * Handlers are bounded by the process's `handlerTimeoutMs`, and so are the commands they dispatch,
 * awaited or not. Each resolves to the state with the fields the handler
 * returned merged over it, validated by the process schema; a deadline's also to what its commands
 * decided. A run whose handler or one of whose commands fails, or that runs out of time, is
 * abandoned: its commands are refused from then on. A step on an instance whose state names a
 * person whose processing is restricted is refused with `ProcessingRestrictedError` before its
 * handler runs, as a command of theirs would be.
 */
export interface ProcessHandlers {
  runEventHandler(args: RunEventHandlerArgs): Promise<object>;
  /**
   * Runs the handler of `due`, if it has one.
   */
  runDeadlineHandler(args: RunDeadlineHandlerArgs): Promise<DeadlineRun>;
}

export interface DeadlineRun {
  readonly state: object;
  readonly decided: readonly ReactionDispatchResult[];
}

export interface CreateProcessHandlersArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly config: ResolvedConfig;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateProcessHandlersFunction {
  (args: CreateProcessHandlersArgs): ProcessHandlers;
}

export const createProcessHandlers: CreateProcessHandlersFunction = ({
  aggregates,
  pipeline,
  config,
  ids,
  clock,
  logger,
}) => {
  const reactionFor = (
    process: ProcessRuntime,
    context: CausationContext,
    idempotencyKey: string,
    within: UnitStores,
  ): ReactionCommands =>
    createReactionCommands({
      aggregates,
      pipeline,
      context,
      idempotencyKey,
      within,
      logger,
      ids,
      clock,
      maxChainDepth: config.forAggregate(process.aggregate).policies.maxChainDepth,
    });

  const handlerArgs = (
    process: ProcessRuntime,
    reaction: ReactionCommands,
    idempotencyKey: string,
    triggeredAt: string,
    own: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> =>
    withPorts(process.ports, {
      commands: reaction.commands,
      signal: reaction.signal,
      forget: reaction.forget,
      idempotencyKey,
      after: afterFrom(triggeredAt),
      ...own,
    });

  const runOf = async <Result>(
    reaction: Pick<ReactionCommands, "abandon">,
    handle: () => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await handle();
    } catch (error) {
      reaction.abandon(error);
      throw error;
    }
  };

  // Waits for every command the handler dispatched, awaited or not, before the step commits.
  const settled = async (
    reaction: Pick<ReactionCommands, "decided">,
    handle: () => unknown,
  ): Promise<{
    readonly returned: unknown;
    readonly decided: readonly ReactionDispatchResult[];
  }> => {
    const returned = await handle();
    return { returned, decided: await reaction.decided() };
  };

  const runEventHandler = ({
    process,
    event,
    instanceId,
    instance,
    attempt,
    retryId,
    actor,
    within,
  }: RunEventHandlerArgs): Promise<object> => {
    within.read(openedUnder(event));
    within.read(instance.persons);
    const idempotencyKey = deriveIdempotencyKey({
      kind: "process",
      handler: process.name,
      subject: event.id,
      retryId,
    });
    const context = { ...causedBy(event), ...actedBy(actor) };
    const reaction = reactionFor(process, context, idempotencyKey, within);
    return runOf(reaction, async () => {
      await refuseRestricted({
        persons: within.persons,
        person: instancePersonOf(process, instanceId, instance),
      });
      const { returned } = await traced({
        errorText: config.runtime.telemetry.errorText,
        name: `bounda.process ${process.name}`,
        attributes: {
          [ATTRIBUTES.process]: process.name,
          [ATTRIBUTES.eventId]: event.id,
          [ATTRIBUTES.eventType]: event.type,
          [ATTRIBUTES.aggregateType]: event.aggregateType,
          [ATTRIBUTES.aggregateId]: event.aggregateId,
          [ATTRIBUTES.correlationId]: event.metadata.correlationId,
          [ATTRIBUTES.attempt]: attempt,
          ...actorAttribute(context.actor),
        },
        run: () =>
          withTimeout({
            run: () =>
              settled(reaction, () =>
                handlerOf(
                  process,
                  event,
                )?.(
                  handlerArgs(process, reaction, idempotencyKey, event.timestamp, {
                    event,
                    state: instance.state,
                    aggregateId: instanceId,
                  }),
                ),
              ),
            timeoutMs: process.handlerTimeoutMs,
            subject: `process ${process.name}`,
            clock,
          }),
      });
      return validState(process, merged(instance.state, returned), instanceId);
    });
  };

  const runDeadlineHandler = async ({
    process,
    instanceId,
    instance,
    due,
    context,
    causationId,
    retryId,
    within,
  }: RunDeadlineHandlerArgs): Promise<DeadlineRun> => {
    within.read(instance.persons);
    const refused = () =>
      refuseRestricted({
        persons: within.persons,
        person: instancePersonOf(process, instanceId, instance),
      });
    const handler = process.deadlineHandlers[due.field];
    if (handler === undefined) {
      await refused();
      return { state: validState(process, instance.state, instanceId), decided: [] };
    }
    const idempotencyKey = deriveIdempotencyKey({
      kind: "process",
      handler: process.name,
      subject: `${instanceId}:deadline:${due.field}:${new Date(due.at).toISOString()}`,
      retryId,
    });
    const reaction = reactionFor(
      process,
      { ...context, causationId, depth: 0 },
      idempotencyKey,
      within,
    );
    return runOf(reaction, async () => {
      await refused();
      const { returned, decided } = await traced({
        errorText: config.runtime.telemetry.errorText,
        name: `bounda.process ${process.name} at ${due.field}`,
        attributes: {
          [ATTRIBUTES.process]: process.name,
          [ATTRIBUTES.aggregateType]: process.aggregate,
          [ATTRIBUTES.aggregateId]: instanceId,
          [ATTRIBUTES.correlationId]: context.correlationId,
          ...actorAttribute(context.actor),
        },
        run: () =>
          withTimeout({
            run: () =>
              settled(reaction, () =>
                handler(
                  handlerArgs(process, reaction, idempotencyKey, due.at, {
                    state: instance.state,
                    aggregateId: instanceId,
                  }),
                ),
              ),
            timeoutMs: process.handlerTimeoutMs,
            subject: `process ${process.name} at ${due.field}`,
            clock,
          }),
      });
      return {
        state: validState(process, merged(instance.state, returned), instanceId),
        decided,
      };
    });
  };

  return { runEventHandler, runDeadlineHandler };
};

// A field left `undefined` keeps its value instead of falling back to its default. What is not an
// object goes on as returned, for `validState` to refuse.
const merged = (state: object, returned: unknown): unknown =>
  returned === undefined ? state : isRecord(returned) ? mergeFields(state, returned) : returned;

export interface ValidStateFunction {
  (
    process: Pick<ProcessRuntime, "name" | "stateSchema" | "personal">,
    state: unknown,
    instanceId: string,
  ): object;
}

// A personal value with nobody named to seal it under fails the step here, as a handler's own
// mistake, rather than at the commit.
export const validState: ValidStateFunction = (process, state, instanceId) => {
  if (process.stateSchema === null) {
    if (isRecord(state)) return state;
    throw new ValidationError(`Process ${process.name} returned a state that is not an object`, [
      { path: [], message: "Return the fields that change, or nothing" },
    ]);
  }
  const parsed = process.stateSchema.safeParse(state);
  if (parsed.success) {
    const data = parsed.data as Readonly<Record<string, unknown>>;
    if (process.personal !== null) {
      checkStatePerson({ process: process.name, marks: process.personal, state: data, instanceId });
    }
    return data;
  }
  throw new ValidationError(
    `Process ${process.name} returned a state its schema refuses`,
    parsed.error.issues.map((issue) => ({
      path: issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
      message: issue.message,
    })),
  );
};
