import { ConfigurationError } from "@bounda-dev/core";
import type { RequestArgs } from "./actor.ts";

/**
 * Names the store a request reaches: every tenant is its own database, with its own events, read
 * models and key, a Durable Object on Cloudflare, an app booted for it in Node. Called the first
 * time a request uses `bounda`, and once per request.
 */
export interface TenantFunction {
  (args: RequestArgs): string | Promise<string>;
}

export interface TenantOfModuleFunction {
  (module: Readonly<Record<string, unknown>>): TenantFunction;
}

/**
 * The `tenant` `app/tenant.ts` exports, refused when it is no function.
 */
export const tenantOfModule: TenantOfModuleFunction = (module) => {
  const { tenant } = module;
  if (typeof tenant !== "function") {
    throw new ConfigurationError(
      "app/tenant.ts does not export tenant, a function of the request that names its store",
    );
  }
  return tenant as TenantFunction;
};

export interface TenantOfRequestFunction {
  (tenant: TenantFunction, args: RequestArgs): Promise<string>;
}

export const tenantOfRequest: TenantOfRequestFunction = async (tenant, args) => {
  const name: unknown = await tenant(args);
  if (typeof name !== "string") {
    throw new ConfigurationError(
      `tenant must name the store of a request with a string, got ${JSON.stringify(name)}`,
    );
  }
  return name;
};
