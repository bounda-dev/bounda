import { ConfigurationError } from "../contracts/errors.ts";
import { DEFAULT_TENANT } from "./personal-data/tenant-keys.ts";

export interface TenantIdOfFunction {
  (tenant: string | undefined): string;
}

/**
 * The id every store keys the tenant by: `DEFAULT_TENANT` for an app that names none, so an app
 * started with `DEFAULT_TENANT` named, as `bounda export-tenant default` starts one, reaches what
 * the app that names none wrote. An empty name is refused: it names no tenant, and the forget
 * ledger once kept the app that names none under it.
 */
export const tenantIdOf: TenantIdOfFunction = (tenant) => {
  if (tenant === "") {
    throw new ConfigurationError(
      `The tenant is named with an empty string: name it, or leave it out to serve ${DEFAULT_TENANT}`,
    );
  }
  return tenant ?? DEFAULT_TENANT;
};

export interface PortTenantOfFunction {
  (tenantId: string): string | undefined;
}

/**
 * The tenant a port implementation's `create` and the access log receive: none for
 * `DEFAULT_TENANT`, whether the app named it or not.
 */
export const portTenantOf: PortTenantOfFunction = (tenantId) =>
  tenantId === DEFAULT_TENANT ? undefined : tenantId;
