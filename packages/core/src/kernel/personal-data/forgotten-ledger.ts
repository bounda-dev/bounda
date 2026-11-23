import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import type { TenantForgetting } from "../../adapter/storage/tenant-key-store.ts";
import type { Logger } from "../../contracts/logger.ts";
import { HOLD_MS } from "./hold.ts";

/**
 * The forget ledger of a forgotten tenant: kept while a copy of its database restored before
 * every recipient was told could still need the disclosures it holds, then cleared.
 */
export interface ForgottenLedger {
  /**
   * Removes the entries older than `keepFor`, at most once every `reconcileEvery`, as the periodic
   * reconciliation does while the tenant is not forgotten. Never rejects.
   */
  retain(now: Date): Promise<void>;
  /**
   * Clears the ledger, and resolves `null` once it did, or to when to try again: at the next pass
   * after a clear that removed part only, after a hold after a failure, or once every entry written
   * before the forgetting shows in a ledger whose reads lag its writes. Never rejects.
   */
  clear(forgetting: TenantForgetting, now: Date): Promise<Date | null>;
}

export interface CreateForgottenLedgerArgs {
  readonly ledger: Pick<ForgetLedger, "clear" | "prune" | "visibilityDelayMs">;
  /**
   * `null` keeps every entry until the ledger is cleared.
   */
  readonly keepForMs: number | null;
  readonly reconcileEveryMs: number;
  readonly tenant: string;
  readonly logger: Logger;
}

export interface CreateForgottenLedgerFunction {
  (args: CreateForgottenLedgerArgs): ForgottenLedger;
}

export const createForgottenLedger: CreateForgottenLedgerFunction = ({
  ledger,
  keepForMs,
  reconcileEveryMs,
  tenant,
  logger,
}) => {
  let retainedAt = Number.NEGATIVE_INFINITY;
  return {
    retain: async (now) => {
      const { prune } = ledger;
      if (keepForMs === null || prune === undefined) return;
      const at = now.getTime();
      if (at - retainedAt < reconcileEveryMs) return;
      retainedAt = at;
      try {
        await prune.call(ledger, { before: new Date(at - keepForMs).toISOString() });
      } catch (error) {
        logger.error("the forgotten tenant's forget ledger could not be pruned", {
          tenant,
          error,
        });
      }
    },
    clear: async (forgetting, now) => {
      // Nothing is appended for the tenant after its forgetting: once that is shown, all is.
      const shownAt = Date.parse(forgetting.at) + (ledger.visibilityDelayMs ?? 0);
      if (now.getTime() < shownAt) return new Date(shownAt);
      try {
        // Past now, so the rest waits for the next pass: this one spent its operations on a batch.
        if (!(await ledger.clear())) return new Date(now.getTime() + 1);
      } catch (error) {
        logger.error("the forgotten tenant's forget ledger could not be cleared", {
          tenant,
          error,
        });
        return new Date(now.getTime() + HOLD_MS);
      }
      logger.warn("tenant forgotten: its recipients are told, and its forget ledger cleared", {
        tenant,
      });
      return null;
    },
  };
};
