import type { BoundaClient, Registry } from "@bounda-dev/core";
import { createContext } from "react-router";
import { type ActorFunction, actAs } from "../actor.ts";
import type { Bounda, BoundaMiddleware } from "../create-bounda.ts";
import { withIdempotencyKey } from "../idempotency-key.ts";
import type { ClientOfFunction } from "./clients.ts";

export interface ServeFunction {
  <R extends Registry>(
    load: () => ClientOfFunction<R> | Promise<ClientOfFunction<R>>,
    actor?: ActorFunction,
  ): Bounda<R>;
}

export const serve: ServeFunction = <R extends Registry>(
  load: () => ClientOfFunction<R> | Promise<ClientOfFunction<R>>,
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
  return { bounda, boundaMiddleware, dispose: async () => {} };
};
