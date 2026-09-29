import type { DispatchOptions, DispatchResult } from "../../contracts/command.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";

/**
 * The untyped shape of `app.commands`. The generated types narrow it per project.
 */
export type CommandsFacadeRuntime = Readonly<
  Record<string, (payload?: unknown, options?: DispatchOptions) => Promise<DispatchResult>>
>;

export interface FacadeDispatchArgs {
  readonly type: string;
  readonly payload: unknown;
  readonly options?: DispatchOptions;
}

export interface CreateCommandsFacadeArgs {
  readonly aggregates: AggregatesRuntime;
  readonly dispatch: (command: FacadeDispatchArgs) => Promise<DispatchResult>;
}

export interface CreateCommandsFacadeFunction {
  (args: CreateCommandsFacadeArgs): CommandsFacadeRuntime;
}

/**
 * One function per command key, each handing its command to `dispatch`.
 */
export const createCommandsFacade: CreateCommandsFacadeFunction = ({ aggregates, dispatch }) =>
  Object.fromEntries(
    Object.values(aggregates.commandsByType).map(({ command }) => [
      command.key,
      (payload?: unknown, options?: DispatchOptions) =>
        dispatch({ type: command.type, payload, ...(options === undefined ? {} : { options }) }),
    ]),
  );
