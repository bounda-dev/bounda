import type { EphemeralKeys } from "../../adapter/adapter.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { ephemeralMasterKey } from "./master-key.ts";
import { defineTenantKeyStore } from "./tenant-key-source.ts";

export interface CreateEphemeralKeysFunction {
  (tenantKeys?: TenantKeyStore): EphemeralKeys;
}

/**
 * A master key that can never be exported and a tenant key store in memory, both gone with the
 * process: what an adapter whose database lives in the process brings, since nothing it keeps
 * outlives the process either.
 */
export const createEphemeralKeys: CreateEphemeralKeysFunction = (
  tenantKeys = createMemoryTenantKeyStore(),
) => {
  return {
    keyWrapper: ephemeralMasterKey(),
    tenantKeys: defineTenantKeyStore(() => tenantKeys),
  };
};
