import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { ReactionDispatchResult } from "../../contracts/command.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "../command/pipeline.ts";
import { createReactionCommands, type ReactionCommands } from "../command/reaction-commands.ts";
import { deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { isRecord, mergeFields } from "../shared/merge-fields.ts";
import { withTimeout } from "../shared/timeout.ts";
import { withCollaborators } from "../shared/with-collaborators.ts";
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
 * Handlers are bounded by the aggregate's policy timeout, as policy handlers are, and so are the
 * commands they dispatch, awaited or not. Each resolves to the state with the fields the handler
 * returned merged over it, validated by the process schema; a deadline's also to what its commands
 * decided. A run whose handler or one of whose commands fails, or that runs out of time, is
 * abandoned: its commands are refused from then on.
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
  clock,
  logger,
}) => {
  const reactionFor = (
    context: CausationContext,
    idempotencyKey: string,
    within: UnitStores,
  ): ReactionCommands =>
    createReactionCommands({ aggregates, pipeline, context, idempotencyKey, within, logger });

  const handlerArgs = (
    process: ProcessRuntime,
    reaction: ReactionCommands,
    idempotencyKey: string,
    triggeredAt: string,
    own: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> =>
    withCollaborators(process.collaborators, {
      commands: reaction.commands,
      signal: reaction.signal,
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
      const { returned } = await traced({
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
            timeoutMs: timeoutMs(process),
            subject: `process ${process.name}`,
            clock,
          }),
      });
      return validState(process, merged(instance.state, returned));
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
  }: RunDeadlineHandlerArgs): Promise<DeadlineRun> => {
    const handler = process.deadlineHandlers[due.field];
    if (handler === undefined) {
      return runOf({ abandon: () => undefined }, async () => ({
        state: validState(process, instance.state),
        decided: [],
      }));
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
      const { returned, decided } = await traced({
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
              settled(reaction, () =>
                handler(
                  handlerArgs(process, reaction, idempotencyKey, due.at, {
                    state: instance.state,
                    aggregateId: instanceId,
                  }),
                ),
              ),
            timeoutMs: timeoutMs(process),
            subject: `process ${process.name} at ${due.field}`,
            clock,
          }),
      });
      return {
        state: validState(process, merged(instance.state, returned)),
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
  (process: Pick<ProcessRuntime, "name" | "stateSchema">, state: unknown): object;
}

export const validState: ValidStateFunction = (process, state) => {
  if (process.stateSchema === null) {
    if (isRecord(state)) return state;
    throw new ValidationError(`Process ${process.name} returned a state that is not an object`, [
      { path: [], message: "Return the fields that change, or nothing" },
    ]);
  }
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
