import type { Tenancy, TenancyStore } from "../adapter/storage/tenancy-store.ts";

export interface MemoryTenancyStore extends TenancyStore {
  rows(): readonly Readonly<Record<string, unknown>>[];
}

export interface CreateMemoryTenancyStoreFunction {
  (): MemoryTenancyStore;
}

export const createMemoryTenancyStore: CreateMemoryTenancyStoreFunction = () => {
  let held: Tenancy | null = null;
  return {
    get: async () => held,
    bind: async (tenancy) => {
      held ??= { ...tenancy, forgottenAt: null };
      return held;
    },
    forget: async (at) => {
      if (held !== null && held.forgottenAt === null) held = { ...held, forgottenAt: at };
    },
    rows: () =>
      held === null
        ? []
        : [
            {
              scope: "app",
              tenant: held.tenant,
              store: held.store,
              bound_at: held.boundAt,
              forgotten_at: held.forgottenAt,
            },
          ],
  };
};
