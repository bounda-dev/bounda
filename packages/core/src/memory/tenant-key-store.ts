import type {
  TenantKeyStore,
  VersionedTenantKeyRecord,
} from "../adapter/storage/tenant-key-store.ts";

export interface MemoryTenantKeyStore extends TenantKeyStore {
  rows(): readonly Readonly<Record<string, unknown>>[];
}

export interface CreateMemoryTenantKeyStoreFunction {
  (): MemoryTenantKeyStore;
}

/**
 * Every tenant's record, kept as long as the store: in the process alone.
 */
export const createMemoryTenantKeyStore: CreateMemoryTenantKeyStoreFunction = () => {
  const records = new Map<string, VersionedTenantKeyRecord>();
  return {
    get: async (tenant) => records.get(tenant) ?? null,
    put: async (tenant, record, expected) => {
      if ((records.get(tenant)?.revision ?? null) !== expected) return false;
      records.set(tenant, { ...record, revision: (expected ?? 0) + 1 });
      return true;
    },
    remove: async (tenant, expected) => {
      if (records.get(tenant)?.revision !== expected) return false;
      records.delete(tenant);
      return true;
    },
    list: async ({ cursor, limit }) => {
      const tenants = [...records.keys()]
        .filter((tenant) => cursor === null || tenant > cursor)
        .sort((a, b) => (a < b ? -1 : 1))
        .slice(0, limit);
      return { tenants, cursor: tenants.length < limit ? null : (tenants.at(-1) ?? null) };
    },
    rows: () =>
      [...records].map(([tenant, { revision, ...record }]) => ({
        tenant,
        revision,
        record: JSON.stringify(record),
      })),
  };
};
