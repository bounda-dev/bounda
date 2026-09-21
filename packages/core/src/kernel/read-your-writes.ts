import type { DispatchOptions, DispatchResult } from "../contracts/command.ts";
import type { CommandsFacade, Registry } from "../modules/registry.ts";
import type { BoundaApp } from "./app.ts";
import type { CommandsFacadeRuntime } from "./command/facade.ts";

export interface ReadYourWritesFunction {
  <R extends Registry>(app: BoundaApp<R>): BoundaApp<R>;
}

/**
 * The same app with `commands` that bring the read models up to date before resolving, so that a
 * query issued right after a command sees its events. Meant for request handlers that redirect to
 * a page reading what they just wrote. Policies, processes and scheduled commands still run in the
 * background; commands dispatched from inside the runtime are not affected.
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
        if (!result.scheduled) await app.catchUpReadModels();
        return result;
      },
    ]),
  );
  return { ...app, commands: caughtUp as CommandsFacade<R> };
};
