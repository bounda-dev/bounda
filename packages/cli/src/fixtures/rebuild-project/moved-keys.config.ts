import { defineConfig, defineTenantKeyStore, masterKey } from "@bounda-dev/core/config";
import { type MemoryAdapter, memory } from "@bounda-dev/core/memory";

// One store per tenant, kept for the process, and two tenant key stores: the one every tenant
// started in, and the one the tenants MOVED_TENANTS names moved to, which MOVED_DOWN takes down.
// The tenants export names the default tenant, whose configuration names the first, and those
// MOVED_REACH names; a tenant whose name starts with "broken" has no configuration.
const stores = new Map<string, MemoryAdapter>();
const firstKeys = memory().createTenantKeyStore();
const movedKeys = memory().createTenantKeyStore();
const first = defineTenantKeyStore(() => firstKeys);
const moved = defineTenantKeyStore(() => {
  if (process.env.MOVED_DOWN !== undefined) throw new Error("the store is down");
  return movedKeys;
});

const storeOf = (tenant: string): MemoryAdapter => {
  const known = stores.get(tenant);
  if (known !== undefined) return known;
  const created = memory();
  stores.set(tenant, created);
  return created;
};

export const tenants = async () => [
  "default",
  ...(process.env.MOVED_REACH ?? "").split(",").filter((tenant) => tenant !== ""),
];

export default defineConfig(({ tenant }) => {
  if (tenant.startsWith("broken")) throw new Error(`${tenant} has no configuration`);
  return {
    storage: storeOf(tenant),
    runtime: {
      role: "all",
      personalData: {
        keyWrapper: masterKey({ from: "MOVED_MASTER" }),
        tenantKeys: (process.env.MOVED_TENANTS ?? "").split(",").includes(tenant) ? moved : first,
      },
    },
  };
});
