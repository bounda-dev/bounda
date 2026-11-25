import { defineConfig } from "@bounda-dev/core/config";
import { type MemoryAdapter, memory } from "@bounda-dev/core/memory";

// One store per tenant, and one forget ledger for all of them, kept for the process; a tenant whose
// name starts with "unloadable" has no configuration, and one whose name starts with "unkept" no
// keepFor.
const stores = new Map<string, MemoryAdapter>();
export const ledger: MemoryAdapter = memory();

const storeOf = (tenant: string): MemoryAdapter => {
  const known = stores.get(tenant);
  if (known !== undefined) return known;
  const created = memory();
  stores.set(tenant, created);
  return created;
};

export default defineConfig(({ tenant }) => {
  if (tenant.startsWith("unloadable")) throw new Error(`${tenant} has no database`);
  return {
    storage: storeOf(tenant),
    runtime: {
      role: "all",
      personalData: {
        forgetLedger: tenant.startsWith("unkept")
          ? { store: ledger }
          : { store: ledger, keepFor: "30d" },
      },
    },
  };
});
