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
 * Thrown by a command a handler dispatches after its run was abandoned, or that was still running
 * when it was; `cause` is why the run was abandoned.
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
   * What the run's commands decided, in the order they finished, once every dispatch, awaited by
   * the handler or not, has settled.
   */
  decided(): Promise<readonly ReactionDispatchResult[]>;
  /**
   * Ends a run that failed or timed out: `signal` aborts, which stops the commands still running,
   * and later dispatches are refused. Nothing is undone, since the run's unit of work is never
   * committed. A dispatch the handler does not await is never reported as unhandled for it.
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

const ignore = (): void => undefined;

export const createReactionCommands: CreateReactionCommandsFunction = ({
  aggregates,
  pipeline,
  context,
  idempotencyKey,
  within,
}) => {
  const commandIds = createReactionCommandIds(idempotencyKey);
  const handler = new AbortController();
  // A second signal, so the commands are refused with the reason wrapped while the handler's
  // signal carries it as it is.
  const abandoned = new AbortController();
  // Abandoning the run rejects the dispatches it stops or refuses, which a handler that did not
  // await one would leave unhandled, and Node ends the process on that. They are marked handled
  // before they can reject; the handler still sees the rejection through its own await.
  const dispatched = new Set<Promise<ReactionDispatchResult>>();
  const results: ReactionDispatchResult[] = [];
  const commands = createCommandsFacade({
    aggregates,
    dispatch: (command) => {
      const dispatch = (async () => {
        const result = decided(
          await pipeline.dispatch({
            ...command,
            context: { ...context, depth: context.depth + 1 },
            commandId: commandIds(command.type),
            within,
            signal: abandoned.signal,
          }),
        );
        results.push(result);
        return result;
      })();
      if (abandoned.signal.aborted) dispatch.catch(ignore);
      else dispatched.add(dispatch);
      return dispatch;
    },
  });
  return {
    commands,
    signal: handler.signal,
    decided: async () => {
      for (let settled = 0; settled < dispatched.size; ) {
        settled = dispatched.size;
        await Promise.allSettled(dispatched);
      }
      return [...results];
    },
    abandon: (reason) => {
      for (const dispatch of dispatched) dispatch.catch(ignore);
      abandoned.abort(new ReactionAbandonedError(reason));
      handler.abort(reason);
    },
  };
};
