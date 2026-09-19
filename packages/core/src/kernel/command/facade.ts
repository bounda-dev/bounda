import type { DispatchOptions, DispatchResult } from "../../contracts/command.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { CommandPipeline } from "./pipeline.ts";

/**
 * The untyped shape of `app.commands`. The generated types narrow it per project.
 */
export type CommandsFacadeRuntime = Readonly<
  Record<string, (payload?: unknown, options?: DispatchOptions) => Promise<DispatchResult>>
>;

export interface CreateCommandsFacadeArgs {
  readonly aggregates: AggregatesRuntime;
  readonly pipeline: CommandPipeline;
  /**
   * Set when the facade is handed to a policy or process handler, so the commands it dispatches
   * inherit the correlation of the event being handled.
   */
  readonly context?: CausationContext;
}

export interface CreateCommandsFacadeFunction {
  (args: CreateCommandsFacadeArgs): CommandsFacadeRuntime;
}

/**
 * Builds `app.commands`: one function per command key that dispatches through the pipeline. A
 * facade created with a context dispatches every command one causal hop deeper.
 */
export const createCommandsFacade: CreateCommandsFacadeFunction = ({
  aggregates,
  pipeline,
  context,
}) =>
  Object.fromEntries(
    Object.values(aggregates.commandsByType).map(({ command }) => [
      command.key,
      (payload?: unknown, options?: DispatchOptions) =>
        pipeline.dispatch({
          type: command.type,
          payload,
          ...(options === undefined ? {} : { options }),
          ...(context === undefined ? {} : { context: { ...context, depth: context.depth + 1 } }),
        }),
    ]),
  );
