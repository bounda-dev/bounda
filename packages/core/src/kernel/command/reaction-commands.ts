import type { Scheduler } from "../../adapter/ports/scheduler.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { createReactionCommandIds } from "../shared/idempotency-key.ts";
import { type CommandsFacadeRuntime, createCommandsFacade } from "./facade.ts";
import { type CommandPipeline, scheduledCommandKey } from "./pipeline.ts";

/**
 * The commands of one run of a policy or process handler.
 */
export interface ReactionCommands {
  readonly commands: CommandsFacadeRuntime;
  /**
   * Aborted when the run is abandoned, so the handler can stop what it still does outside.
   */
  readonly signal: AbortSignal;
  /**
   * Ends a run that failed or timed out: later dispatches reject with `reason`, `signal` aborts,
   * and the delayed commands the run scheduled are cancelled once the dispatches in flight
   * settle, so a retry that takes another path leaves none behind.
   */
  abandon(reason: unknown): Promise<void>;
}

export interface CreateReactionCommandsArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  readonly scheduler: Scheduler;
  /**
   * The context of what the handler reacts to; its commands go one causal hop deeper.
   */
  readonly context: CausationContext;
  readonly idempotencyKey: string;
}

export interface CreateReactionCommandsFunction {
  (args: CreateReactionCommandsArgs): ReactionCommands;
}

export const createReactionCommands: CreateReactionCommandsFunction = ({
  aggregates,
  pipeline,
  scheduler,
  context,
  idempotencyKey,
}) => {
  const commandIds = createReactionCommandIds(idempotencyKey);
  const controller = new AbortController();
  const scheduled = new Set<string>();
  const delayed: Promise<unknown>[] = [];
  const commands = createCommandsFacade({
    aggregates,
    dispatch: (command) => {
      if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
      const commandId = commandIds(command.type);
      const dispatched = pipeline.dispatch({
        ...command,
        context: { ...context, depth: context.depth + 1 },
        commandId,
      });
      if (command.options?.delay === undefined) return dispatched;
      scheduled.add(scheduledCommandKey(commandId));
      delayed.push(dispatched);
      return dispatched;
    },
  });
  return {
    commands,
    signal: controller.signal,
    abandon: async (reason) => {
      controller.abort(reason);
      await Promise.allSettled(delayed);
      for (const key of scheduled) await scheduler.cancel(key);
    },
  };
};
