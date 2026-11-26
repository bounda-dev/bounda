import {
  defineConfig,
  defineTenantKeyStore,
  masterKey,
  type ProjectTenants,
} from "@bounda-dev/core/config";
import { type MemoryAdapter, memory } from "@bounda-dev/core/memory";

// One store per tenant, kept for the process; a tenant whose name starts with "own" keeps its key
// in a tenant key store of its own, which nothing else lists, the others in one they share, and
// one whose name starts with "broken" has no configuration. The tenants are those REWRAP_TENANTS
// names.
const stores = new Map<string, MemoryAdapter>();
const sharedKeys = memory().createTenantKeyStore();
const shared = defineTenantKeyStore(() => sharedKeys);
const own = new Map<string, ReturnType<typeof defineTenantKeyStore>>();

const storeOf = (tenant: string): MemoryAdapter => {
  const known = stores.get(tenant);
  if (known !== undefined) return known;
  const created = memory();
  stores.set(tenant, created);
  return created;
};

const keysOf = (tenant: string) => {
  if (!tenant.startsWith("own")) return shared;
  const known = own.get(tenant);
  if (known !== undefined) return known;
  const keys = memory().createTenantKeyStore();
  const created = defineTenantKeyStore(() => keys);
  own.set(tenant, created);
  return created;
};

export const tenants: ProjectTenants = async () =>
  (process.env.REWRAP_TENANTS ?? "").split(",").filter((tenant) => tenant !== "");

// The master key REWRAP_FROM names, and REWRAP_PREVIOUS the one before, read on every load.
export default defineConfig(({ tenant }) => {
  if (tenant.startsWith("broken")) throw new Error(`${tenant} has no configuration`);
  return {
    storage: storeOf(tenant),
    runtime: {
      role: "all",
      personalData: {
        keyWrapper: masterKey({
          from: process.env.REWRAP_FROM ?? "REWRAP_A",
          previous: process.env.REWRAP_PREVIOUS === undefined ? [] : [process.env.REWRAP_PREVIOUS],
        }),
        tenantKeys: keysOf(tenant),
      },
    },
  };
});
