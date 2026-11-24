import type { ReadModelStorage, Storage } from "../adapter/adapter.ts";
import type { ForgetLedger } from "../adapter/storage/forget-ledger.ts";
import { isFenceError, type TenantFence } from "../adapter/storage/tenant-fence.ts";
import type { Clock } from "../contracts/clock.ts";
import { TenantForgottenError, TenantFrozenError } from "../contracts/errors.ts";
import type { LogFields, Logger } from "../contracts/logger.ts";
import { TENANT_CHECK_INTERVAL_MS } from "./personal-data/forgotten-tenant.ts";
import type { TenantKeys } from "./personal-data/tenant-keys.ts";

/**
 * A tenant frozen: since when it takes no write.
 */
export interface TenantFrozenResult {
  readonly tenant: string;
  readonly frozenAt: string;
}

// Every store of a tenant that holds a fence of its own.
export interface FencedStores {
  readonly tenant: string;
  readonly storage: Pick<Storage, "fence">;
  readonly readModels: readonly { readonly storage: Pick<ReadModelStorage, "fence"> }[];
  readonly ledger: Pick<ForgetLedger, "fence" | "visibilityDelayMs"> | null;
  readonly tenantKeys: Pick<TenantKeys, "freeze" | "unfreeze"> | null;
}

export interface FreezeStoresArgs extends FencedStores {
  readonly clock: Clock;
  // Commits what the ledger recorded and the database does not hold yet, once the ledger takes
  // no entry more and before the database takes no write more.
  readonly drain: () => Promise<void>;
}

export interface FreezeStoresFunction {
  (args: FreezeStoresArgs): Promise<TenantFrozenResult>;
}

const refuseForgotten = (fence: TenantFence): void => {
  if (fence.state === "forgotten") throw new TenantForgottenError(fence.tenant, fence.since);
};

const waitFor = (clock: Clock, milliseconds: number): Promise<void> =>
  new Promise((resume) => {
    clock.after(milliseconds, resume);
  });

// Every fence with the time the first raise took. The ledger goes first, so no intention lands
// that the database would then refuse; what it recorded is committed while the database still
// takes writes; the read models go last, as only the stream feeds them. A freeze cut short is
// finished by the next one.
export const freezeStores: FreezeStoresFunction = async ({
  tenant,
  storage,
  readModels,
  ledger,
  tenantKeys,
  clock,
  drain,
}) => {
  const current = await storage.fence.read();
  refuseForgotten(current);
  const fence: TenantFence =
    current.state === "frozen"
      ? current
      : { state: "frozen", tenant, since: clock.now().toISOString() };
  if (ledger !== null) {
    refuseForgotten(await ledger.fence.set(fence));
    // An entry appended before the fence shows in a read once this delay passed.
    const delayMs = ledger.visibilityDelayMs ?? 0;
    if (delayMs > 0) await waitFor(clock, delayMs);
  }
  await drain();
  refuseForgotten(await storage.fence.set(fence));
  await tenantKeys?.freeze(fence.since);
  for (const { storage: readModel } of readModels) await readModel.fence.set(fence);
  return { tenant, frozenAt: fence.since };
};

export interface UnfreezeStoresFunction {
  (stores: FencedStores): Promise<void>;
}

// The key record goes first, so a record that says frozen means the database was, unless a copy
// restored by hand lowered it (see `createFreezeKeeper`). The ledger's fence goes last: an
// intention it took while the database still refused its commit would be committed by a
// reconciliation after the caller was told it was refused.
export const unfreezeStores: UnfreezeStoresFunction = async ({
  storage,
  readModels,
  ledger,
  tenantKeys,
}) => {
  const open: TenantFence = { state: "open" };
  refuseForgotten(await storage.fence.read());
  await tenantKeys?.unfreeze();
  refuseForgotten(await storage.fence.set(open));
  for (const { storage: readModel } of readModels) await readModel.fence.set(open);
  if (ledger !== null) refuseForgotten(await ledger.fence.set(open));
};

export interface WhollyFrozenFunction {
  (stores: Omit<FencedStores, "tenantKeys">): Promise<string | null>;
}

// Since when every store of the tenant is frozen, `null` while one is not.
export const whollyFrozen: WhollyFrozenFunction = async ({ storage, readModels, ledger }) => {
  const fence = await storage.fence.read();
  if (fence.state !== "frozen") return null;
  for (const { storage: readModel } of readModels) {
    if ((await readModel.fence.read()).state !== "frozen") return null;
  }
  if (ledger !== null && (await ledger.fence.read()).state !== "frozen") return null;
  return fence.since;
};

// What an instance knows of its tenant's freeze.
export interface FenceWatch {
  // Whether the tenant was frozen as this instance read last: its background work waits.
  frozen(): boolean;
  // Reads the database's fence again, at most once every `TENANT_CHECK_INTERVAL_MS` unless `now`.
  check(options?: { readonly now?: boolean }): Promise<void>;
  // What a write refused by a freeze tells: the tenant is frozen.
  refused(error: unknown): void;
}

export interface CreateFenceWatchArgs {
  readonly storage: Pick<Storage, "fence">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly frozen: boolean;
}

export interface CreateFenceWatchFunction {
  (args: CreateFenceWatchArgs): FenceWatch;
}

export const createFenceWatch: CreateFenceWatchFunction = ({
  storage,
  clock,
  logger,
  frozen: frozenAtStart,
}) => {
  let frozen = frozenAtStart;
  let checkedAt = clock.now().getTime();
  let checking: Promise<void> | null = null;
  const read = async (): Promise<void> => {
    checkedAt = clock.now().getTime();
    const fence = await storage.fence.read();
    const was = frozen;
    frozen = fence.state === "frozen";
    if (was && !frozen) logger.info("the tenant is no longer frozen: its background work goes on");
  };
  return {
    frozen: () => frozen,
    check: async ({ now = false } = {}) => {
      const at = clock.now().getTime();
      if (!now && at >= checkedAt && at - checkedAt < TENANT_CHECK_INTERVAL_MS) return;
      checking ??= read().finally(() => {
        checking = null;
      });
      await checking;
    },
    refused: (error) => {
      if (!(error instanceof TenantFrozenError) || frozen) return;
      frozen = true;
      checkedAt = clock.now().getTime();
      logger.info("the tenant is frozen: its background work waits for it to thaw", {
        frozenAt: error.frozenAt,
      });
    },
  };
};

export interface FenceAwareLoggerFunction {
  (logger: Logger, refused: (error: unknown) => void): Logger;
}

// Background work a freeze or a forgetting stops is waiting, not failing: logged as information.
export const fenceAwareLogger: FenceAwareLoggerFunction = (logger, refused) => ({
  debug: (message, fields) => logger.debug(message, fields),
  info: (message, fields) => logger.info(message, fields),
  warn: (message, fields) => logger.warn(message, fields),
  error: (message: string, fields?: LogFields) => {
    const error = fields?.error;
    if (!isFenceError(error)) {
      logger.error(message, fields);
      return;
    }
    refused(error);
    logger.info(message, { ...fields, fenced: error.code });
  },
});

export interface CreateFreezeKeeperArgs {
  readonly tenant: string;
  // The fence of each database of the tenant: the storage's, and each read model's.
  readonly stores: () => readonly Pick<Storage, "fence">[];
  // Since when the tenant key record, read now, says the tenant is frozen; `null` while it is not.
  readonly record: () => Promise<string | null>;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface FreezeKeeper {
  // Raises again the fence of each database that shows it open while the tenant key record says
  // the tenant is frozen, and resolves to whether it raised any.
  keep(): Promise<boolean>;
  // What this instance's own freeze or thaw recorded.
  recorded(frozenAt: string | null): void;
}

export interface CreateFreezeKeeperFunction {
  (args: CreateFreezeKeeperArgs): FreezeKeeper;
}

// A copy restored by hand brings back the fence it held, and the record, in a store apart, is what
// says the tenant is frozen. The record is read again at most once every
// `TENANT_CHECK_INTERVAL_MS`, and the fences only while it says frozen; a raise the record no
// longer backs once read again, as a thaw that lowered it meanwhile, is lowered back.
export const createFreezeKeeper: CreateFreezeKeeperFunction = ({
  tenant,
  stores,
  record,
  clock,
  logger,
}) => {
  let known: string | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  // `undefined` when the record could not be read, which is logged: nothing is decided on it.
  const read = async (): Promise<string | null | undefined> => {
    try {
      return await record();
    } catch (error) {
      logger.error("the tenant key record could not be read for the tenant's freeze", { error });
      return undefined;
    }
  };
  return {
    keep: async () => {
      const now = clock.now().getTime();
      if (now < readAt || now - readAt >= TENANT_CHECK_INTERVAL_MS) {
        readAt = now;
        const fresh = await read();
        if (fresh !== undefined) known = fresh;
      }
      if (known === null) return false;
      const open: Pick<Storage, "fence">[] = [];
      for (const store of stores()) {
        if ((await store.fence.read()).state === "open") open.push(store);
      }
      if (open.length === 0) return false;
      const since = await read();
      if (since === undefined) return false;
      known = since;
      if (since === null) return false;
      for (const store of open) await store.fence.set({ state: "frozen", tenant, since });
      if ((await read()) === null) {
        known = null;
        for (const store of open) await store.fence.set({ state: "open" });
        return false;
      }
      logger.warn(
        "the tenant is frozen and a database's fence was open, as a copy restored by hand leaves it: raised again",
        { tenant, frozenAt: since, databases: open.length },
      );
      return true;
    },
    recorded: (frozenAt) => {
      known = frozenAt;
      readAt = clock.now().getTime();
    },
  };
};
