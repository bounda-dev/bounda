import type {
  DispatchResult,
  ReactionDispatchResult,
  RejectedDispatch,
} from "../../contracts/command.ts";
import { BoundaError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
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
 * Thrown by a command a handler dispatches once its run has finished, from a timer or a promise it
 * left behind: the run's unit of work no longer takes its commands, whether it committed or not.
 */
export class ReactionFinishedError extends BoundaError {
  readonly command: string;

  constructor(command: string) {
    super(
      "REACTION_FINISHED",
      `Command ${command} was dispatched after its run had finished: dispatch commands while the handler runs`,
    );
    this.command = command;
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
   * the handler or not, has settled; rejects with the first that failed. The run awaits it before
   * its attempt commits, so a dispatch the handler did not await still counts. Once it settles,
   * later dispatches are refused.
   */
  decided(): Promise<readonly ReactionDispatchResult[]>;
  /**
   * Ends a run that failed or timed out: `signal` aborts, which stops the commands still running,
   * and later dispatches are refused. Nothing is undone, since the run's unit of work is never
   * committed.
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
  /**
   * Where a command dispatched once the run has finished is reported.
   */
  readonly logger: Logger;
}

export interface CreateReactionCommandsFunction {
  (args: CreateReactionCommandsArgs): ReactionCommands;
}

const decided = (result: DispatchResult | RejectedDispatch): ReactionDispatchResult => {
  if ("rejected" in result) return result;
  if (result.scheduled) return { rejected: false, ...result };
  const { position: _position, ...decision } = result;
  return { rejected: false, ...decision };
};

export const createReactionCommands: CreateReactionCommandsFunction = ({
  aggregates,
  pipeline,
  context,
  idempotencyKey,
  within,
  logger,
}) => {
  const commandIds = createReactionCommandIds(idempotencyKey);
  const handler = new AbortController();
  // A second signal, so the commands are refused with the reason wrapped while the handler's
  // signal carries it as it is.
  const abandoned = new AbortController();
  // A dispatch the handler does not await would leave its failure unhandled, and Node ends the
  // process on that. Each is marked handled when it is made, and `decided` reports the failure, or
  // the logger the refusal of one made once the run has finished; the handler still sees either
  // through its own await.
  const dispatched = new Set<Promise<ReactionDispatchResult>>();
  const results: ReactionDispatchResult[] = [];
  let failure: { readonly error: unknown } | undefined;
  let finished = false;
  const commands = createCommandsFacade({
    aggregates,
    dispatch: (command) => {
      if (finished && !abandoned.signal.aborted) {
        logger.error("command dispatched after its run had finished; refused", {
          command: command.type,
          correlationId: context.correlationId,
          causationId: context.causationId,
        });
        const refused = Promise.reject(new ReactionFinishedError(command.type));
        refused.catch(() => undefined);
        return refused;
      }
      const dispatch = (async () => {
        const result = decided(
          await pipeline.dispatchUnattended({
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
      // A command the handler withdrew with its own signal is not a failure of the run.
      const withdrawal = command.options?.signal;
      dispatch.catch((error: unknown) => {
        if (withdrawal?.aborted && error === withdrawal.reason) return;
        failure ??= { error };
      });
      if (!abandoned.signal.aborted) dispatched.add(dispatch);
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
      finished = true;
      if (failure !== undefined) throw failure.error;
      return [...results];
    },
    abandon: (reason) => {
      abandoned.abort(new ReactionAbandonedError(reason));
      handler.abort(reason);
    },
  };
};
