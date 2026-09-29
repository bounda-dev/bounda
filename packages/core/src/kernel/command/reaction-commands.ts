import type { Scheduler } from "../../adapter/ports/scheduler.ts";
import type { DispatchResult, ReactionDispatchResult } from "../../contracts/command.ts";
import { BoundaError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { createReactionCommandIds } from "../shared/idempotency-key.ts";
import { errorDetails } from "../shared/retry.ts";
import type { UnitStores } from "../unit-of-work/unit-of-work.ts";
import { type CommandsFacadeRuntime, createCommandsFacade } from "./facade.ts";
import { type CommandPipeline, scheduledCommandKey } from "./pipeline.ts";

/**
 * Thrown by a command a handler dispatches after its run was abandoned; `cause` is why the run
 * was abandoned.
 */
export class ReactionAbandonedError extends BoundaError {
  constructor(reason: unknown) {
    super(
      "REACTION_ABANDONED",
      `The run that dispatched this command was abandoned: ${errorDetails(reason).message}`,
      { cause: reason },
    );
  }
}

/**
 * The commands of one run of a policy or process handler.
 */
export interface ReactionCommands {
  readonly commands: CommandsFacadeRuntime<ReactionDispatchResult>;
  /**
   * Aborted when the run is abandoned, so the handler can stop what it still does outside.
   */
  readonly signal: AbortSignal;
  /**
   * Ends a run that failed or timed out: later dispatches are refused and `signal` aborts. A run
   * with a unit of work needs nothing undone, since the unit is never committed. Without one, the
   * delayed commands the run scheduled are cancelled; a delayed command still being scheduled is
   * neither waited for nor cancelled once it lands, since by then a retry may have scheduled the
   * same command under the same key. Never throws, so the run's own error stands.
   */
  abandon(reason: unknown): Promise<void>;
}

export interface CreateReactionCommandsArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  /**
   * The context of what the handler reacts to; its commands go one causal hop deeper.
   */
  readonly context: CausationContext;
  readonly idempotencyKey: string;
  /**
   * The run's unit of work, when it has one: its commands write there, to commit with the
   * attempt. Without it they write to the store at once.
   */
  readonly within?: UnitStores | undefined;
}

export interface CreateReactionCommandsFunction {
  (args: CreateReactionCommandsArgs): ReactionCommands;
}

const decided = (result: DispatchResult): ReactionDispatchResult => {
  if (result.scheduled) return result;
  const { position: _position, ...decision } = result;
  return decision;
};

export const createReactionCommands: CreateReactionCommandsFunction = ({
  aggregates,
  pipeline,
  scheduler,
  logger,
  context,
  idempotencyKey,
  within,
}) => {
  const commandIds = createReactionCommandIds(idempotencyKey);
  const controller = new AbortController();
  const delayed: string[] = [];
  const cancel = (key: string): Promise<void> =>
    scheduler.cancel(key).catch((error: unknown) => {
      logger.warn("delayed command of an abandoned run not cancelled", {
        dedupeKey: key,
        error: errorDetails(error).message,
      });
    });
  const commands = createCommandsFacade({
    aggregates,
    dispatch: async (command) => {
      if (controller.signal.aborted) {
        throw new ReactionAbandonedError(controller.signal.reason);
      }
      const commandId = commandIds(command.type);
      const dispatched = pipeline.dispatch({
        ...command,
        context: { ...context, depth: context.depth + 1 },
        commandId,
        within,
      });
      if (within === undefined && command.options?.delay !== undefined) {
        delayed.push(scheduledCommandKey(commandId));
      }
      return decided(await dispatched);
    },
  });
  return {
    commands,
    signal: controller.signal,
    abandon: async (reason) => {
      controller.abort(reason);
      await Promise.all(delayed.map(cancel));
    },
  };
};
