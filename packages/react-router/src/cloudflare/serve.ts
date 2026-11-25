import type { BoundaClient, Registry } from "@bounda-dev/core";
import { createContext } from "react-router";
import { type ActorFunction, actAs } from "../actor.ts";
import type { Bounda, BoundaMiddleware } from "../create-bounda.ts";
import type { HandleBoundaErrorFunction } from "../handle-error.ts";
import type { RefuseRequestFunction } from "../host-log.ts";
import { withIdempotencyKey } from "../idempotency-key.ts";
import type { ClientOfFunction } from "./clients.ts";

export interface ServeArgs<R extends Registry> {
  /**
   * The clients of each request, loaded on the first one.
   */
  readonly load: () => ClientOfFunction<R> | Promise<ClientOfFunction<R>>;
  readonly handleErrorOf: (host: object) => HandleBoundaErrorFunction;
  readonly refusalsOf: (host: object) => RefuseRequestFunction;
  readonly actor?: ActorFunction | undefined;
}

export interface ServeFunction {
  <R extends Registry>(args: ServeArgs<R>): Bounda<R>;
}

export const serve: ServeFunction = <R extends Registry>({
  load,
  handleErrorOf,
  refusalsOf,
  actor,
}: ServeArgs<R>): Bounda<R> => {
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

  // The tenant is named on the request's first call, after the actor: an actor refused here is
  // recorded without one.
  const boundaMiddleware: BoundaMiddleware = async (args, next) => {
    const client = await actAs((await clients())(args, refuse), actor, args, (reason) =>
      refuse(args, reason),
    );
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
  const refuse = refusalsOf(served);
  return served;
};
