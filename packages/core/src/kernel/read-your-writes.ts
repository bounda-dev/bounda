import type { DispatchOptions, DispatchResult } from "../contracts/command.ts";
import type { CommandsFacade, Registry } from "../modules/registry.ts";
import type { BoundaApp } from "./app.ts";
import type { CommandsFacadeRuntime } from "./command/facade.ts";

export interface ReadYourWritesFunction {
  <R extends Registry>(app: BoundaApp<R>): BoundaApp<R>;
}

/**
 * The same app with `commands` that wait, before resolving, for the read models their events
 * change, so that a query issued right after a command sees them. Only the read models that
 * project those events are waited for, only up to the command's own position, and for at most
 * `runtime.dispatcher.catchUp.timeout`, after which the command resolves anyway and a warning is
 * logged. Meant for request handlers that redirect to a page reading what they just wrote.
 * Policies, processes and scheduled commands still run in the background; commands dispatched
 * from inside the runtime are not affected.
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
