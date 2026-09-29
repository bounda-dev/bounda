import type { Scheduler } from "../../adapter/ports/scheduler.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import { createReactionCommands, type ReactionCommands } from "../command/reaction-commands.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { withTimeout } from "../shared/timeout.ts";
import { ATTRIBUTES, traced } from "../telemetry.ts";
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
}

/**
 * One run of a process handler: the state it left, and `record`, which writes it. A run whose
 * handler fails, or whose `record` throws, is abandoned: its commands are refused from then on
 * and the delayed ones it scheduled are cancelled.
 */
export interface HandlerRun {
  readonly state: object;
  record(write: () => Promise<void>): Promise<void>;
}

/**
 * Runs the handlers users write for a process, traced and bounded by the policy timeout. The
 * state they leave is parsed with the process `state` schema; a handler that returns nothing
 * leaves the state as it was.
 */
export interface ProcessHandlers {
  runEventHandler(args: RunEventHandlerArgs): Promise<HandlerRun>;
  /**
   * Runs the handler of `due`, if it has one.
   */
  runDeadlineHandler(args: RunDeadlineHandlerArgs): Promise<HandlerRun>;
}

export interface CreateProcessHandlersArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly scheduler: Scheduler;
  readonly config: ResolvedConfig;
  readonly clock: Clock;
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
}) => {
  const reactionFor = (context: CausationContext, idempotencyKey: string): ReactionCommands =>
    createReactionCommands({ aggregates, pipeline, scheduler, context, idempotencyKey });

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

  const abandonOnError = async <T>(
    reaction: Pick<ReactionCommands, "abandon">,
    step: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      await reaction.abandon(error);
      throw error;
    }
  };

  const runOf = async (
    reaction: Pick<ReactionCommands, "abandon">,
    handle: () => Promise<object>,
  ): Promise<HandlerRun> => ({
    state: await abandonOnError(reaction, handle),
    record: (write) => abandonOnError(reaction, write),
  });

  const timeoutMs = (process: ProcessRuntime): number =>
    config.forAggregate(process.aggregate).policies.timeoutMs;

  const runEventHandler = ({
    process,
    event,
    instanceId,
    instance,
    attempt,
    replay,
  }: RunEventHandlerArgs): Promise<HandlerRun> => {
    const idempotencyKey = deriveIdempotencyKey({
      kind: "process",
      handler: process.name,
      subject: event.id,
      replay,
    });
    const reaction = reactionFor(eventContext(event), idempotencyKey);
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
  }: RunDeadlineHandlerArgs): Promise<HandlerRun> => {
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

/**
 * The state a handler returned, parsed with the process `state` schema when it has one.
 */
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
