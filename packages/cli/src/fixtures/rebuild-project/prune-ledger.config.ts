import { defineConfig } from "@bounda-dev/core/config";
import { type MemoryAdapter, memory } from "@bounda-dev/core/memory";

// One store per tenant, and one forget ledger for all of them, kept for the process; a tenant whose
// name starts with "unloadable" has no configuration, one whose name starts with "unkept" no
// keepFor, and one whose name starts with "moved" a ledger of its own since its ledger moved.
const stores = new Map<string, MemoryAdapter>();
export const ledger: MemoryAdapter = memory();
export const moved: MemoryAdapter = memory();

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
          : { store: tenant.startsWith("moved") ? moved : ledger, keepFor: "30d" },
      },
    },
  };
});
