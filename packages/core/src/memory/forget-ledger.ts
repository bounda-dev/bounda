import {
  byForgetLedgerOrder,
  type ForgetLedger,
  type ForgetLedgerEntry,
} from "../adapter/storage/forget-ledger.ts";
import { createMemoryTenantFence, type MemoryTenantFence } from "./tenant-fence.ts";

export interface MemoryForgetLedgers {
  ledgerOf(tenant: string): ForgetLedger;
  /**
   * Every tenant's entries, each with its tenant.
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
  const marks = new Map<string, number>();
  const fences = new Map<string, MemoryTenantFence>();
  return {
    rows: () =>
      [...byTenant.entries()].flatMap(([tenant, entries]) =>
        [...entries.values()].map((entry) => ({ tenant, ...entry })),
      ),
    ledgerOf: (tenant) => {
      const entries = byTenant.get(tenant) ?? new Map<string, ForgetLedgerEntry>();
      byTenant.set(tenant, entries);
      const fence = fences.get(tenant) ?? createMemoryTenantFence();
      fences.set(tenant, fence);
      return {
        append: (appended) =>
          fence.write(async () => {
            for (const entry of appended) {
              const kept = entries.get(entry.eventId);
              if (kept === undefined) entries.set(entry.eventId, { ...entry });
              else if (entry.committed !== false) {
                const { committed: _, ...committed } = kept;
                entries.set(entry.eventId, committed);
              }
            }
          }),
        read: async ({ after, limit }) =>
          [...entries.values()]
            .filter((entry) => after === undefined || byForgetLedgerOrder(entry, after) > 0)
            .sort(byForgetLedgerOrder)
            .slice(0, limit)
            .map((entry) => ({ ...entry })),
        prune: async ({ before }) => {
          for (const [eventId, entry] of entries) {
            if (entry.forgottenAt < before) entries.delete(eventId);
          }
        },
        readMark: async (name) => marks.get(`${tenant}\u0000${name}`) ?? 0,
        raiseMark: (name, value) =>
          fence.write(async () => {
            const mark = `${tenant}\u0000${name}`;
            marks.set(mark, Math.max(marks.get(mark) ?? 0, value));
          }),
        clear: async () => {
          entries.clear();
          for (const mark of marks.keys()) {
            if (mark.startsWith(`${tenant}\u0000`)) marks.delete(mark);
          }
          return true;
        },
        fence: fence.store,
      };
    },
  };
};
