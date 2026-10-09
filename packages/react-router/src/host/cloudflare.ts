import { env } from "cloudflare:workers";
import { type AppRegistry, ConfigurationError, type Registry } from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import { checkConsistency } from "../check-consistency.ts";
import { cloudflareClients, type TenantFunction } from "../cloudflare/clients.ts";
import { serve } from "../cloudflare/serve.ts";
import type { Bounda } from "../create-bounda.ts";
import type { CreateHostArgs, CreateHostFunction } from "./args.ts";

export { failure } from "../failure.ts";
export type { CreateHostArgs, CreateHostFunction } from "./args.ts";

/**
 * The host the `bounda()` Vite plugin serves the app from under the `workerd` condition: the
 * `createBounda` of `@bounda-dev/react-router/cloudflare`, with the project's configuration and
 * the `tenant` of its `app/tenant.ts`, both imported on the first request. Not meant to be called
 * by hand. Throws `ConfigurationError` for a `consistency` it does not know; the first request
 * rejects with one without `app/tenant.ts`, or as `createBounda` does.
 */
export const createHost: CreateHostFunction = <R extends Registry = AppRegistry>({
  importConfig,
  importTenant,
  consistency,
}: CreateHostArgs<R>): Bounda<R> => {
  checkConsistency(consistency);
  return serve<R>(async () => {
    if (importTenant === undefined) {
      throw new ConfigurationError(
        'On Cloudflare every request reaches the store of its tenant: create app/tenant.ts and export tenant from it, a function of the request that names the store, such as () => "default" for a single one',
      );
    }
    const [{ default: config }, { tenant }] = await Promise.all([importConfig(), importTenant()]);
    if (config === undefined) {
      throw new ConfigurationError(
        "bounda.config.ts does not export the configuration (default export)",
      );
    }
    if (typeof tenant !== "function") {
      throw new ConfigurationError(
        "app/tenant.ts does not export tenant, a function of the request that names its store",
      );
    }
    return cloudflareClients<R>({
      env,
      config: config as Config,
      tenant: tenant as TenantFunction,
      consistency,
    });
  });
};
