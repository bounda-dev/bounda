import {
  byForgetLedgerOrder,
  type ForgetLedger,
  type ForgetLedgerEntry,
} from "../adapter/storage/forget-ledger.ts";

export interface MemoryForgetLedgers {
  ledgerOf(tenant: string | undefined): ForgetLedger;
  /**
   * Every tenant's entries, each with its tenant, `""` for none.
   */
  rows(): readonly Readonly<Record<string, unknown>>[];
}

export interface CreateMemoryForgetLedgersFunction {
  (): MemoryForgetLedgers;
}

/**
 * Every tenant's entries, by event id, kept as long as the adapter that holds them.
 */
export const createMemoryForgetLedgers: CreateMemoryForgetLedgersFunction = () => {
  const byTenant = new Map<string, Map<string, ForgetLedgerEntry>>();
  return {
    rows: () =>
      [...byTenant.entries()].flatMap(([tenant, entries]) =>
        [...entries.values()].map((entry) => ({ tenant, ...entry })),
      ),
    ledgerOf: (tenant) => {
      const key = tenant ?? "";
      const entries = byTenant.get(key) ?? new Map<string, ForgetLedgerEntry>();
      byTenant.set(key, entries);
      return {
        append: async (appended) => {
          for (const entry of appended) {
            if (entries.has(entry.eventId)) continue;
            entries.set(
              entry.eventId,
              entry.fingerprints === undefined
                ? { ...entry }
                : { ...entry, fingerprints: [...entry.fingerprints] },
            );
          }
        },
        read: async ({ after, limit }) =>
          [...entries.values()]
            .filter((entry) => after === undefined || byForgetLedgerOrder(entry, after) > 0)
            .sort(byForgetLedgerOrder)
            .slice(0, limit)
            .map((entry) =>
              entry.fingerprints === undefined
                ? { ...entry }
                : { ...entry, fingerprints: [...entry.fingerprints] },
            ),
        prune: async ({ before }) => {
          for (const [eventId, entry] of entries) {
            if (entry.forgottenAt < before) entries.delete(eventId);
          }
        },
      };
    },
  };
};
