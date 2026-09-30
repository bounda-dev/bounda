import type { DispatchOptions, DispatchResult } from "../../contracts/command.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";

/**
 * The untyped shape of `app.commands`, and of a reaction's `commands` with its own result. The
 * generated types narrow it per project.
 */
export type CommandsFacadeRuntime<Result = DispatchResult> = Readonly<
  Record<string, (payload?: unknown, options?: DispatchOptions) => Promise<Result>>
>;

export interface FacadeDispatchArgs {
  readonly type: string;
  readonly payload: unknown;
  readonly options?: DispatchOptions;
}

export interface CreateCommandsFacadeArgs<Result> {
  readonly aggregates: AggregatesRuntime;
  readonly dispatch: (command: FacadeDispatchArgs) => Promise<Result>;
}

export interface CreateCommandsFacadeFunction {
  <Result>(args: CreateCommandsFacadeArgs<Result>): CommandsFacadeRuntime<Result>;
}

export const createCommandsFacade: CreateCommandsFacadeFunction = <Result>({
  aggregates,
  dispatch,
}: CreateCommandsFacadeArgs<Result>): CommandsFacadeRuntime<Result> =>
  Object.fromEntries(
    Object.values(aggregates.commandsByType).map(({ command }) => [
      command.key,
      (payload?: unknown, options?: DispatchOptions) =>
        dispatch({ type: command.type, payload, ...(options === undefined ? {} : { options }) }),
    ]),
  );
