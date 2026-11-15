import { defineConfig } from "@bounda-dev/core/config";
import { type MemoryAdapter, memory } from "@bounda-dev/core/memory";

// One store per tenant, kept for the process, as one database per tenant would be.
const stores = new Map<string, MemoryAdapter>();

const storeOf = (tenant: string): MemoryAdapter => {
  const known = stores.get(tenant);
  if (known !== undefined) return known;
  const created = memory();
  stores.set(tenant, created);
  return created;
};

export default defineConfig(({ tenant }) => ({
  storage: storeOf(tenant),
  runtime: { role: "all" },
}));
