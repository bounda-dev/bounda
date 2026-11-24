import { ConfigurationError } from "../contracts/errors.ts";
import { DEFAULT_TENANT } from "./personal-data/tenant-keys.ts";

export interface TenantIdOfFunction {
  (tenant: string | undefined): string;
}

// The one id every store and port knows the tenant by. An empty name is refused: it names no
// tenant, and the forget ledger once kept the app that names none under it.
export const tenantIdOf: TenantIdOfFunction = (tenant) => {
  if (tenant === "") {
    throw new ConfigurationError(
      `The tenant is named with an empty string, which names none: give it a name, or name none to serve ${DEFAULT_TENANT}`,
    );
  }
  return tenant ?? DEFAULT_TENANT;
};
