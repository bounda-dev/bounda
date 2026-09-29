import type { Scheduler } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import { createReactionCommands, type ReactionCommands } from "../command/reaction-commands.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { withTimeout } from "../shared/timeout.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";
import type { UnitStores } from "../unit-of-work/unit-of-work.ts";
import type { ProcessRuntime } from "./build-processes.ts";
import { afterFrom, type Deadline } from "./deadlines.ts";
import { eventContext, type ProcessInstance } from "./lifecycle.ts";
import { handlerOf } from "./routes.ts";

export interface RunEventHandlerArgs {
  readonly process: ProcessRuntime;
  readonly event: StoredEvent;
  readonly instanceId: string;
  readonly instance: ProcessInstance;
  readonly attempt: number;
  /**
   * Set when a dead letter is replayed, so the handler's `idempotencyKey` differs from the failed
   * run's.
   */
  readonly replay?: string | undefined;
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
  readonly replay?: string | undefined;
  readonly within: UnitStores;
}

/**
 * Handlers are bounded by the aggregate's policy timeout, as policy handlers are. Each resolves to
 * the state the handler returned, validated by the process schema, or the state as it was when
 * the handler returned nothing. A run whose handler fails or runs out of time is abandoned: its
 * commands are refused from then on.
 */
export interface ProcessHandlers {
  runEventHandler(args: RunEventHandlerArgs): Promise<object>;
  /**
   * Runs the handler of `due`, if it has one.
   */
  runDeadlineHandler(args: RunDeadlineHandlerArgs): Promise<object>;
}

export interface CreateProcessHandlersArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly scheduler: Scheduler;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateProcessHandlersFunction {
  (args: CreateProcessHandlersArgs): ProcessHandlers;
}

export const createProcessHandlers: CreateProcessHandlersFunction = ({
  aggregates,
  pipeline,
  scheduler,
  config,
  clock,
  logger,
}) => {
  const reactionFor = (
    context: CausationContext,
    idempotencyKey: string,
    within: UnitStores,
  ): ReactionCommands =>
    createReactionCommands({
      aggregates,
      pipeline,
      scheduler,
      logger,
      context,
      idempotencyKey,
      within,
    });

  const handlerArgs = (
    process: ProcessRuntime,
    reaction: ReactionCommands,
    idempotencyKey: string,
    triggeredAt: string,
  ): Record<string, unknown> => ({
    ...process.collaborators,
    commands: reaction.commands,
    signal: reaction.signal,
    idempotencyKey,
    after: afterFrom(triggeredAt),
  });

  const runOf = async (
    reaction: Pick<ReactionCommands, "abandon">,
    handle: () => Promise<object>,
  ): Promise<object> => {
    try {
      return await handle();
    } catch (error) {
      await reaction.abandon(error);
      throw error;
    }
  };

  const timeoutMs = (process: ProcessRuntime): number =>
    config.forAggregate(process.aggregate).policies.timeoutMs;

  const runEventHandler = ({
    process,
    event,
    instanceId,
    instance,
    attempt,
    replay,
    within,
  }: RunEventHandlerArgs): Promise<object> => {
    const idempotencyKey = deriveIdempotencyKey({
      kind: "process",
      handler: process.name,
      subject: event.id,
      replay,
    });
    const reaction = reactionFor(eventContext(event), idempotencyKey, within);
    return runOf(reaction, async () => {
      const next = await traced({
        name: `bounda.process ${process.name}`,
        attributes: {
          [ATTRIBUTES.process]: process.name,
          [ATTRIBUTES.eventId]: event.id,
          [ATTRIBUTES.eventType]: event.type,
          [ATTRIBUTES.aggregateType]: event.aggregateType,
          [ATTRIBUTES.aggregateId]: event.aggregateId,
          [ATTRIBUTES.correlationId]: event.metadata.correlationId,
          [ATTRIBUTES.attempt]: attempt,
        },
        run: () =>
          withTimeout({
            run: () =>
              handlerOf(
                process,
                event,
              )?.({
                ...handlerArgs(process, reaction, idempotencyKey, event.timestamp),
                event,
                state: instance.state,
                aggregateId: instanceId,
              }),
            timeoutMs: timeoutMs(process),
            subject: `process ${process.name}`,
            clock,
          }),
      });
      return validState(process, next === undefined ? instance.state : next);
    });
  };

  const runDeadlineHandler = ({
    process,
    instanceId,
    instance,
    due,
    context,
    causationId,
    replay,
    within,
  }: RunDeadlineHandlerArgs): Promise<object> => {
    const handler = process.deadlineHandlers[due.field];
    if (handler === undefined) {
      return runOf({ abandon: async () => undefined }, async () =>
        validState(process, instance.state),
      );
    }
    const idempotencyKey = deriveIdempotencyKey({
      kind: "process",
      handler: process.name,
      subject: `${instanceId}:deadline:${due.field}:${new Date(due.at).toISOString()}`,
      replay,
    });
    const reaction = reactionFor(
      { correlationId: context.correlationId, causationId, depth: 0 },
      idempotencyKey,
      within,
    );
    return runOf(reaction, async () => {
      const returned = await traced({
        name: `bounda.process ${process.name} at ${due.field}`,
        attributes: {
          [ATTRIBUTES.process]: process.name,
          [ATTRIBUTES.aggregateType]: process.aggregate,
          [ATTRIBUTES.aggregateId]: instanceId,
          [ATTRIBUTES.correlationId]: context.correlationId,
        },
        run: () =>
          withTimeout({
            run: () =>
              handler({
                ...handlerArgs(process, reaction, idempotencyKey, due.at),
                state: instance.state,
                aggregateId: instanceId,
              }),
            timeoutMs: timeoutMs(process),
            subject: `process ${process.name} at ${due.field}`,
            clock,
          }),
      });
      return validState(process, returned ?? instance.state);
    });
  };

  return { runEventHandler, runDeadlineHandler };
};

export interface ValidStateFunction {
  (process: Pick<ProcessRuntime, "name" | "stateSchema">, state: unknown): object;
}

export const validState: ValidStateFunction = (process, state) => {
  if (process.stateSchema === null) return state as object;
  const parsed = process.stateSchema.safeParse(state);
  if (parsed.success) return parsed.data as object;
  throw new ValidationError(
    `Process ${process.name} returned a state its schema refuses`,
    parsed.error.issues.map((issue) => ({
      path: issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
      message: issue.message,
    })),
  );
};
