import { env } from "cloudflare:workers";
import { workersLogger } from "@bounda-dev/cloudflare";
import {
  type AppRegistry,
  type Consistency,
  checkConsistency,
  errorTextFromEnv,
  type Logger,
  type Registry,
} from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import type { ActorFunction } from "../actor.ts";
import type { Bounda } from "../create-bounda.ts";
import { createHandleError } from "../handle-error.ts";
import { cloudflareClients, type TenantFunction } from "./clients.ts";
import { serve } from "./serve.ts";

export interface CreateBoundaArgs {
  /**
   * The app's configuration, with `storage: cloudflare()`, whose `binding` names the Bounda
   * Durable Object's binding.
   */
  readonly config: Config;
  readonly tenant: TenantFunction;
  /**
   * What a loader sees right after an action dispatched a command. Defaults to
   * `"read-your-writes"`, so the page a redirect lands on already reflects it.
   */
  readonly consistency?: Consistency;
  /**
   * Who makes each request, which the client in its context acts as, over RPC. Left out, requests
   * act as nobody.
   */
  readonly actor?: ActorFunction;
  /**
   * Where `handleError` logs. Defaults to `workersLogger` from `@bounda-dev/cloudflare`, one JSON
   * line per entry.
   */
  readonly logger?: Logger;
}

export interface CreateBoundaFunction {
  <R extends Registry = AppRegistry>(args: CreateBoundaArgs): Bounda<R>;
}

/**
 * Wires a React Router app served by a Worker to the Bounda Durable Objects it binds: the
 * `bounda` context holds, in every loader and action, a client for the store `tenant` names,
 * reached through `connect`. Declare it once in a server module, mount the middleware in
 * `root.tsx` and export `handleError` from `app/entry.server.tsx`, which logs what a request
 * throws as `BOUNDA_ERROR_TEXT` in the Worker's `env` says, or else the configuration's
 * `runtime.telemetry.errorText`; `dispose` does nothing, since the app runs in the objects. A command's `signal`
 * only counts before the call leaves the Worker. Throws `ConfigurationError` when `storage` is not
 * `cloudflare()`, when the Worker has no such binding, without a `tenant`, or for a `consistency`
 * it does not know.
 *
 * @example
 * // app/bounda.server.ts
 * export const { bounda, boundaMiddleware, handleError } = createBounda({
 *   config,
 *   tenant: ({ params }) => params.workspace ?? "default",
 * });
 */
export const createBounda: CreateBoundaFunction = <R extends Registry = AppRegistry>({
  config,
  tenant,
  consistency = "read-your-writes",
  actor,
  logger = workersLogger,
}: CreateBoundaArgs): Bounda<R> => {
  checkConsistency(consistency);
  const clientOf = cloudflareClients<R>({ env, config, tenant, consistency });
  const handleError = createHandleError({
    message: "bounda request failed",
    errorText: () => errorTextFromEnv(env) ?? config.runtime?.telemetry?.errorText ?? "omit",
    logger: () => logger,
  });
  return serve(() => clientOf, handleError, actor);
};
