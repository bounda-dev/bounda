import type { DispatchOptions, DispatchResult } from "../contracts/command.ts";
import type { CommandsFacade, Registry } from "../modules/registry.ts";
import type { BoundaApp } from "./app.ts";
import type { CommandsFacadeRuntime } from "./command/facade.ts";

export interface ReadYourWritesFunction {
  <R extends Registry>(app: BoundaApp<R>): BoundaApp<R>;
}

/**
 * The same app with `commands` that, before resolving, wait for the read models that project
 * their events to reach them, so a query issued right after a command sees its writes. The wait
 * lasts at most `runtime.dispatcher.catchUp.timeout`; then the command resolves anyway and a
 * warning is logged. Meant for request handlers that redirect to a page reading what they just
 * wrote. Policies, processes, scheduled commands and commands dispatched from inside the runtime
 * are not waited for.
 */
export const readYourWrites: ReadYourWritesFunction = <R extends Registry>(
  app: BoundaApp<R>,
): BoundaApp<R> => {
  const commands = app.commands as CommandsFacadeRuntime;
  const caughtUp: CommandsFacadeRuntime = Object.fromEntries(
    Object.entries(commands).map(([key, dispatch]) => [
      key,
      async (payload?: unknown, options?: DispatchOptions): Promise<DispatchResult> => {
        const result = await dispatch(payload, options);
        await app.catchUpReadModels({ through: result });
        return result;
      },
    ]),
  );
  return { ...app, commands: caughtUp as CommandsFacade<R> };
};
