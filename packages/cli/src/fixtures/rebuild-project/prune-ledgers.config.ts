import { defineConfig, type ProjectTenants } from "@bounda-dev/core/config";
import { type MemoryAdapter, memory } from "@bounda-dev/core/memory";

// One store and one forget ledger per tenant, kept for the process; the tenants are those
// PRUNE_TENANTS names, and a tenant whose name starts with "unlistable" has a ledger whose store
// cannot list its tenants.
const stores = new Map<string, MemoryAdapter>();
const ledgers = new Map<string, MemoryAdapter>();

const kept = (made: Map<string, MemoryAdapter>, tenant: string): MemoryAdapter => {
  const known = made.get(tenant);
  if (known !== undefined) return known;
  const created = memory();
  made.set(tenant, created);
  return created;
};

export const ledgerOf = (tenant: string): MemoryAdapter => kept(ledgers, tenant);

export const tenants: ProjectTenants = async () =>
  (process.env.PRUNE_TENANTS ?? "").split(",").filter((tenant) => tenant !== "");

export default defineConfig(({ tenant }) => {
  const ledger = ledgerOf(tenant);
  return {
    storage: kept(stores, tenant),
    runtime: {
      role: "all",
      personalData: {
        forgetLedger: {
          store: tenant.startsWith("unlistable")
            ? {
                ...ledger,
                createForgetLedger: async (args) => {
                  const { tenants: _, ...unlisted } = await ledger.createForgetLedger(args);
                  return unlisted;
                },
              }
            : ledger,
          keepFor: "30d",
        },
      },
    },
  };
});
