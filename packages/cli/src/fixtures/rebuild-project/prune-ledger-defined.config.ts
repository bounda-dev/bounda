import { defineConfig, defineForgetLedger } from "@bounda-dev/core/config";
import { type MemoryAdapter, memory } from "@bounda-dev/core/memory";

// One store per tenant, kept for the process, and one forget ledger for all of them, which the
// configuration defines anew whenever it is called.
const stores = new Map<string, MemoryAdapter>();
export const ledger: MemoryAdapter = memory();

const storeOf = (tenant: string): MemoryAdapter => {
  const known = stores.get(tenant);
  if (known !== undefined) return known;
  const created = memory();
  stores.set(tenant, created);
  return created;
};

export default defineConfig(({ tenant }) => ({
  storage: storeOf(tenant),
  runtime: {
    role: "all",
    personalData: {
      forgetLedger: {
        store: defineForgetLedger(({ tenant: asked }) =>
          ledger.createForgetLedger({ tenant: asked }),
        ),
        keepFor: "30d",
      },
    },
  },
}));
