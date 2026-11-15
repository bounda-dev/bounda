import { defineConfig, defineTenantKeyStore, masterKey } from "@bounda-dev/core/config";
import { type MemoryAdapter, memory } from "@bounda-dev/core/memory";

// One store per tenant, and one tenant key store for all of them, kept for the process.
const stores = new Map<string, MemoryAdapter>();
const keys = memory().createTenantKeyStore();

const storeOf = (tenant: string): MemoryAdapter => {
  const known = stores.get(tenant);
  if (known !== undefined) return known;
  const created = memory();
  stores.set(tenant, created);
  return created;
};

// The master key REWRAP_FROM names, and REWRAP_PREVIOUS the one before, read on every load.
export default defineConfig(({ tenant }) => ({
  storage: storeOf(tenant),
  runtime: {
    role: "all",
    personalData: {
      keyWrapper: masterKey({
        from: process.env.REWRAP_FROM ?? "REWRAP_A",
        previous: process.env.REWRAP_PREVIOUS === undefined ? [] : [process.env.REWRAP_PREVIOUS],
      }),
      tenantKeys: defineTenantKeyStore(() => keys),
    },
  },
}));
