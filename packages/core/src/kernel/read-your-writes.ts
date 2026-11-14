import type { DispatchOptions, DispatchResult, StoredDispatch } from "../contracts/command.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import type { CommandsFacade, Registry } from "../modules/registry.ts";
import type { BoundaApp, BoundaClient } from "./app.ts";
import type { CommandsFacadeRuntime } from "./command/facade.ts";

/**
 * What a query issued right after a command sees, which the host serving the request decides.
 * `"read-your-writes"` brings the read models the command's events reach up to date before the
 * command resolves. `"eventual"` resolves once the events are stored and leaves the read models to
 * the background, so the query may not see them yet.
 */
export type Consistency = "read-your-writes" | "eventual";

export interface CheckConsistencyFunction {
  (consistency: Consistency): void;
}

/**
 * Throws `ConfigurationError` unless `consistency` is `"read-your-writes"` or `"eventual"`. For a
 * host that takes it from code that is not always type-checked, such as a configuration file or a
 * Worker.
 */
export const checkConsistency: CheckConsistencyFunction = (consistency) => {
  if (consistency !== "read-your-writes" && consistency !== "eventual") {
    throw new ConfigurationError(
      `consistency must be "read-your-writes" or "eventual", got ${JSON.stringify(consistency)}`,
    );
  }
};

export interface ReadYourWritesFunction {
  <R extends Registry>(app: BoundaApp<R>): BoundaApp<R>;
}

/**
 * The same app with `commands`, `forget`, `restrict` and `unrestrict` that, before resolving, wait
 * for the read models that project their events to reach them, so a query issued right after a
 * command, or after forgetting or restricting someone, sees its writes. The wait lasts at most `runtime.dispatcher.catchUp.timeout`; then the
 * command resolves anyway and a warning is logged, as it does when a read model cannot be read.
 * Meant for request handlers that redirect to a page reading what they just wrote. Policies,
 * processes, scheduled commands and commands dispatched from inside the runtime are not waited for.
 * A client bound with `as` waits the same way.
 */
export const readYourWrites: ReadYourWritesFunction = <R extends Registry>(
  app: BoundaApp<R>,
): BoundaApp<R> => {
  const caughtUpOn =
    <Options>(act: (personId: string, options: Options) => Promise<StoredDispatch>) =>
    async (personId: string, options: Options): Promise<StoredDispatch> => {
      const result = await act(personId, options);
      await app.catchUpReadModels({ through: result });
      return result;
    };
  const waiting = (
    client: BoundaClient<R>,
  ): Pick<BoundaClient<R>, "commands" | "forget" | "restrict" | "unrestrict" | "redact" | "as"> => {
    const commands = client.commands as CommandsFacadeRuntime;
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
    return {
      commands: caughtUp as CommandsFacade<R>,
      forget: caughtUpOn(client.forget),
      restrict: caughtUpOn(client.restrict),
      unrestrict: caughtUpOn(client.unrestrict),
      redact: caughtUpOn(client.redact),
      as: (actor) => {
        const bound = client.as(actor);
        return { ...bound, ...waiting(bound) };
      },
    };
  };
  return { ...app, ...waiting(app) };
};
