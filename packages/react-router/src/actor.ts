import { type BoundaClient, ConfigurationError, type Registry } from "@bounda-dev/core";
import type { ImportModuleFunction } from "@bounda-dev/core/node";
import type { MiddlewareFunction } from "react-router";

/**
 * What a middleware receives: the request, its route's params and its context.
 */
export type RequestArgs = Parameters<MiddlewareFunction>[0];

/**
 * Names who makes a request: the id of the signed-in user, or of the service calling, read from
 * the session or from what an earlier middleware put in the context; `undefined` for nobody.
 * The client in `context.get(bounda)` then acts as it (`BoundaClient.as`), so every command the
 * request dispatches, and every event those write, records who acted. Never a name or an email:
 * events keep it in the clear and are never deleted. Called once per request, before its loaders
 * and actions run.
 */
export interface ActorFunction {
  (args: RequestArgs): string | undefined | Promise<string | undefined>;
}

export interface ActAsFunction {
  <R extends Registry>(
    client: BoundaClient<R>,
    actor: ActorFunction | undefined,
    args: RequestArgs,
  ): Promise<BoundaClient<R>>;
}

export const actAs: ActAsFunction = async (client, actor, args) => {
  const id = await actor?.(args);
  return id === undefined ? client : client.as(id);
};

export interface ActorOfModuleFunction {
  (importActor: ImportModuleFunction): ActorFunction;
}

/**
 * The `actor` that `app/actor.ts` exports, imported on the first request that needs it, and
 * again on the next one when that import failed.
 */
export const actorOfModule: ActorOfModuleFunction = (importActor) => {
  let loading: Promise<ActorFunction> | undefined;
  const load = (): Promise<ActorFunction> => {
    if (loading !== undefined) return loading;
    const current = importActor().then(({ actor }) => {
      if (typeof actor !== "function") {
        throw new ConfigurationError(
          "app/actor.ts does not export actor, a function of the request that names who makes it",
        );
      }
      return actor as ActorFunction;
    });
    loading = current;
    current.catch(() => {
      loading = undefined;
    });
    return current;
  };
  return async (args) => (await load())(args);
};
