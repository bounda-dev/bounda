import { env } from "cloudflare:workers";
import type { AppRegistry, Consistency, Registry } from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import { checkConsistency } from "../check-consistency.ts";
import type { Bounda } from "../create-bounda.ts";
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
}

export interface CreateBoundaFunction {
  <R extends Registry = AppRegistry>(args: CreateBoundaArgs): Bounda<R>;
}

/**
 * Wires a React Router app served by a Worker to the Bounda Durable Objects it binds: the
 * `bounda` context holds, in every loader and action, a client for the store `tenant` names,
 * reached through `connect`. Declare it once in a server module and mount the middleware in
 * `root.tsx`; `dispose` does nothing, since the app runs in the objects. A command's `signal`
 * only counts before the call leaves the Worker. Throws `ConfigurationError` when `storage` is not
 * `cloudflare()`, when the Worker has no such binding, without a `tenant`, or for a `consistency`
 * it does not know.
 *
 * @example
 * // app/bounda.server.ts
 * export const { bounda, boundaMiddleware } = createBounda({
 *   config,
 *   tenant: ({ params }) => params.workspace ?? "default",
 * });
 */
export const createBounda: CreateBoundaFunction = <R extends Registry = AppRegistry>({
  config,
  tenant,
  consistency = "read-your-writes",
}: CreateBoundaArgs): Bounda<R> => {
  checkConsistency(consistency);
  const clientOf = cloudflareClients<R>({ env, config, tenant, consistency });
  return serve(() => clientOf);
};
