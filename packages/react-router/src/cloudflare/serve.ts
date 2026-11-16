import type { BoundaClient, Registry } from "@bounda-dev/core";
import { createContext } from "react-router";
import { type ActorFunction, actAs } from "../actor.ts";
import type { Bounda, BoundaMiddleware } from "../create-bounda.ts";
import type { HandleBoundaErrorFunction } from "../handle-error.ts";
import { withIdempotencyKey } from "../idempotency-key.ts";
import type { ClientOfFunction } from "./clients.ts";

export interface ServeFunction {
  <R extends Registry>(
    load: () => ClientOfFunction<R> | Promise<ClientOfFunction<R>>,
    handleErrorOf: (host: object) => HandleBoundaErrorFunction,
    actor?: ActorFunction,
  ): Bounda<R>;
}

export const serve: ServeFunction = <R extends Registry>(
  load: () => ClientOfFunction<R> | Promise<ClientOfFunction<R>>,
  handleErrorOf: (host: object) => HandleBoundaErrorFunction,
  actor?: ActorFunction,
): Bounda<R> => {
  const bounda = createContext<BoundaClient<R>>();
  let loading: Promise<ClientOfFunction<R>> | undefined;
  const clients = (): Promise<ClientOfFunction<R>> => {
    loading ??= Promise.resolve()
      .then(load)
      .catch((error: unknown) => {
        loading = undefined;
        throw error;
      });
    return loading;
  };

  const boundaMiddleware: BoundaMiddleware = async (args, next) => {
    const client = await actAs((await clients())(args), actor, args);
    args.context.set(bounda, await withIdempotencyKey(client, args.request));
    return next();
  };

  // The app lives in its Durable Objects: nothing runs in the Worker to stop.
  const served: Bounda<R> = {
    bounda,
    boundaMiddleware,
    dispose: async () => {},
    handleError: (error, args) => handleError(error, args),
  };
  const handleError = handleErrorOf(served);
  return served;
};
