import type { DispatchResult, ReactionDispatchResult } from "../../contracts/command.ts";
import { BoundaError } from "../../contracts/errors.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { createReactionCommandIds } from "../shared/idempotency-key.ts";
import { errorDetails } from "../shared/retry.ts";
import type { UnitStores } from "../unit-of-work/unit-of-work.ts";
import { type CommandsFacadeRuntime, createCommandsFacade } from "./facade.ts";
import type { CommandPipeline } from "./pipeline.ts";

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
   * Ends a run that failed or timed out: later dispatches are refused and `signal` aborts.
   * Nothing is undone, since the run's unit of work is never committed.
   */
  abandon(reason: unknown): void;
}

export interface CreateReactionCommandsArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  /**
   * The context of what the handler reacts to; its commands go one causal hop deeper.
   */
  readonly context: CausationContext;
  readonly idempotencyKey: string;
  /**
   * The run's unit of work: its commands write there, to commit with the attempt.
   */
  readonly within: UnitStores;
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
  context,
  idempotencyKey,
  within,
}) => {
  const commandIds = createReactionCommandIds(idempotencyKey);
  const controller = new AbortController();
  const commands = createCommandsFacade({
    aggregates,
    dispatch: async (command) => {
      if (controller.signal.aborted) {
        throw new ReactionAbandonedError(controller.signal.reason);
      }
      return decided(
        await pipeline.dispatch({
          ...command,
          context: { ...context, depth: context.depth + 1 },
          commandId: commandIds(command.type),
          within,
        }),
      );
    },
  });
  return {
    commands,
    signal: controller.signal,
    abandon: (reason) => controller.abort(reason),
  };
};
