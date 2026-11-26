import { defineConfig, defineForgetLedger } from "@bounda-dev/core/config";
import { type MemoryAdapter, memory } from "@bounda-dev/core/memory";

// One store per tenant, kept for the process, and one forget ledger for all of them, which the
// configuration defines anew whenever it is called. Every tenant a ledger is opened for goes to
// `globalThis.boundaDefinedLedgerOpens`, which a test counts whichever copy of this module it
// imports.
const stores = new Map<string, MemoryAdapter>();
export const ledger: MemoryAdapter = memory();
const holder = globalThis as { boundaDefinedLedgerOpens?: string[] };
holder.boundaDefinedLedgerOpens ??= [];
const opens: string[] = holder.boundaDefinedLedgerOpens;

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
        store: defineForgetLedger(({ tenant: asked }) => {
          opens.push(asked);
          return ledger.createForgetLedger({ tenant: asked });
        }),
        keepFor: "30d",
      },
    },
  },
}));
