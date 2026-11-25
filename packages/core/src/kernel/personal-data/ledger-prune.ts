import { type Adapter, isAdapter, type Storage } from "../../adapter/adapter.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ForgetLedgerPosition,
} from "../../adapter/storage/forget-ledger.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { BOUNDA_AGGREGATE } from "../../modules/bounda-events.ts";
import type { AppEnv } from "../../register/index.ts";
import { forgottenSince } from "../recipients/again.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { tenantIdOf } from "../tenant.ts";
import { withEncryptedFiles } from "./encrypted-files.ts";
import { openForgetLedger } from "./forget-ledger.ts";
import {
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_PAGE,
  FORGET_LEDGER_REREAD_MS,
} from "./reconciliation.ts";

export type AppliedStorage = Pick<
  Storage,
  "checkpointStore" | "eventStore" | "recipients" | "fence"
>;

export interface PruneAsAppliedArgs {
  readonly ledger: Pick<ForgetLedger, "read" | "fence"> & Required<Pick<ForgetLedger, "prune">>;
  // `null` for a database that holds no table yet.
  readonly withStorage: <T>(work: (storage: AppliedStorage | null) => Promise<T>) => Promise<T>;
  readonly keepForMs: number;
  readonly now: Date;
  readonly pageSize?: number;
}

export interface PrunedAsApplied {
  readonly before: string;
  // `before` stopped short of `keepFor`, at the oldest entry the database has yet to apply.
  readonly unapplied: boolean;
}

export interface PruneAsAppliedFunction {
  (args: PruneAsAppliedArgs): Promise<PrunedAsApplied>;
}

// Whether the next reconciliation of the database leaves the entry as it is, and no restore count
// reads it: the database holds its event, or for a disclosure, which has none, holds it or the
// forgetting since that removed it.
const appliedIn = async (storage: AppliedStorage, entry: ForgetLedgerEntry): Promise<boolean> => {
  const { personId, disclosure } = entry;
  if (disclosure === undefined) {
    const held = await storage.eventStore.readOne({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: personId,
      eventId: entry.eventId,
    });
    return held !== null;
  }
  const stored = await storage.recipients.disclosures(personId);
  if (
    stored.some(
      (held) =>
        held.port === disclosure.port &&
        held.recipient === disclosure.recipient &&
        held.kind === disclosure.kind &&
        held.country === disclosure.country &&
        held.safeguard === disclosure.safeguard &&
        held.category === disclosure.category,
    )
  ) {
    return true;
  }
  const { events } = await storage.eventStore.load({
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: personId,
  });
  return forgottenSince(events, { forgottenAt: entry.forgottenAt, disclosure });
};

// Removes the entries older than `keepFor` the database can no longer need: those its reconciliation
// will not read again, and those it applied. A copy restored brought its own cursor back, so what it
// lacks stays until a start applies it.
export const pruneAsApplied: PruneAsAppliedFunction = async ({
  ledger,
  withStorage,
  keepForMs,
  now,
  pageSize = FORGET_LEDGER_PAGE,
}) => {
  const cutoff = new Date(now.getTime() - keepForMs).toISOString();
  const [oldest] = await ledger.read({ limit: 1 });
  if (oldest === undefined || oldest.forgottenAt >= cutoff) {
    return { before: cutoff, unapplied: false };
  }
  // A forgotten tenant's database may be gone already: its ledger's fence tells it first.
  const before =
    (await ledger.fence.read()).state === "forgotten"
      ? cutoff
      : await withStorage(async (storage) => {
          if (storage === null) return oldest.forgottenAt;
          if ((await storage.fence.read()).state === "forgotten") return cutoff;
          const cursor = await storage.checkpointStore.get(FORGET_LEDGER_CURSOR);
          // From before 1970 for a database whose reconciliation read nothing yet.
          let after: ForgetLedgerPosition = {
            forgottenAt: new Date(cursor - FORGET_LEDGER_REREAD_MS).toISOString(),
            eventId: "",
          };
          for (;;) {
            const page = await ledger.read({ after, limit: pageSize });
            for (const entry of page) {
              if (entry.forgottenAt >= cutoff) return cutoff;
              if (!(await appliedIn(storage, entry))) return entry.forgottenAt;
            }
            if (page.length < pageSize) return cutoff;
            after = page.at(-1) ?? after;
          }
        });
  if (before > oldest.forgottenAt) await ledger.prune({ before });
  return { before, unapplied: before < cutoff };
};

export interface PruneTenantForgetLedgerArgs {
  /**
   * The project's configuration for the tenant, as `loadProject` resolves it.
   */
  readonly config: Config;
  /**
   * The environment the forget ledger, the key wrapper and the tenant key store read, such as
   * `process.env`. Defaults to none.
   */
  readonly env?: AppEnv;
  /**
   * The tenant whose entries to prune. Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
  /**
   * Defaults to the current time.
   */
  readonly now?: Date;
}

export interface PrunedTenantForgetLedger {
  readonly tenant: string;
  /**
   * The ledger holds no entry of the tenant older than this any more: `keepFor` before `now`, or,
   * when `unapplied`, the time of the oldest entry the tenant's database has yet to apply.
   */
  readonly before: string;
  /**
   * Whether entries older than `keepFor` are kept because the tenant's database has not applied
   * them, as a copy restored while the app was stopped has not: an app of the tenant applies them
   * at its start, after which they go.
   */
  readonly unapplied: boolean;
}

export interface PruneTenantForgetLedgerFunction {
  (args: PruneTenantForgetLedgerArgs): Promise<PrunedTenantForgetLedger>;
}

export interface ListForgetLedgerTenantsArgs {
  /**
   * The project's configuration, whose forget ledger's store to list, as `loadProject` resolves
   * it for a tenant.
   */
  readonly config: Config;
  /**
   * The environment the forget ledger reads, such as `process.env`. Defaults to none.
   */
  readonly env?: AppEnv;
  /**
   * The tenant the configuration was resolved for. Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
}

export interface ListForgetLedgerTenantsFunction {
  (args: ListForgetLedgerTenantsArgs): Promise<readonly string[]>;
}

const refused = (message: string): ConfigurationError =>
  runtimeText(new ConfigurationError(message));

// The ledger the configuration names for the tenant, with its `keepFor`, refused when there is
// nothing for an operator to prune.
const prunable = async ({ config, env, tenant }: Required<ListForgetLedgerTenantsArgs>) => {
  const resolved = resolveConfig(config);
  const ledgerConfig = resolved.runtime.personalData.forgetLedger;
  if (ledgerConfig === null) {
    throw refused("Pruning the forget ledger needs runtime.personalData.forgetLedger");
  }
  const { keepForMs } = ledgerConfig;
  if (keepForMs === null) {
    throw refused(
      "Pruning the forget ledger needs runtime.personalData.forgetLedger.keepFor: without it, entries are kept until their tenant is forgotten",
    );
  }
  const ledger = await openForgetLedger({
    source: ledgerConfig.store,
    storage: resolved.storage,
    env,
    tenant,
    keepForMs,
  });
  const { prune } = ledger;
  if (prune === undefined) {
    await ledger.close?.();
    throw refused(
      "The forget ledger expires its entries on its own, as Workers KV and a Durable Object's do: there is nothing to prune; for KV keys written before keepFor was set, run bounda forget-ledger expire",
    );
  }
  return { ledger, prune, keepForMs, storage: resolved.storage };
};

/**
 * Prunes a tenant's forget ledger past `keepFor` with no app of the tenant running: what
 * `bounda forget-ledger prune` runs, for a tenant whose app does not run to prune it in its
 * periodic reconciliation. It removes only what the tenant's database no longer needs: an entry
 * older than `keepFor` stays until the database has applied it, so a copy restored while the app
 * was stopped is forgotten again at the next start. Safe beside running instances of the tenant.
 * It opens the tenant's database as `migrateTables` does, through the tenant's keys, only when an
 * entry older than `keepFor` is there, and never a forgotten tenant's, whose ledger it prunes past
 * `keepFor` alone. Rejects with `ConfigurationError` without a forget ledger or `keepFor`, for a
 * ledger that expires its entries on its own, and for a storage only its host opens.
 */
export const pruneTenantForgetLedger: PruneTenantForgetLedgerFunction = async ({
  config,
  env = {},
  tenant: named,
  now = new Date(),
}) => {
  const tenant = tenantIdOf(named);
  const { ledger, prune, keepForMs, storage } = await prunable({ config, env, tenant });
  try {
    if (!isAdapter(storage)) {
      throw refused(
        "The storage is opened only by its host, as a Durable Object's is: its app prunes the forget ledger",
      );
    }
    const pruned = await pruneAsApplied({
      ledger: { read: ledger.read.bind(ledger), fence: ledger.fence, prune: prune.bind(ledger) },
      keepForMs,
      now,
      withStorage: (work) =>
        withEncryptedFiles({
          config,
          env,
          tenant,
          work: async (keyed) => {
            const adapter = resolveConfig(keyed).storage as Adapter;
            const versions = await adapter.schemaVersions();
            // A database without Bounda's tables has applied nothing, and stays without them.
            if (versions.some(({ scope, version }) => scope === "storage" && version === 0)) {
              return work(null);
            }
            const opened = await adapter.createStorage();
            try {
              return await work(opened);
            } finally {
              await opened.close();
            }
          },
        }),
    });
    return { tenant, ...pruned };
  } finally {
    await ledger.close?.();
  }
};

/**
 * Every tenant whose entries the store of the configuration's forget ledger holds, in code-unit
 * order: the tenants `bounda forget-ledger prune --all-tenants` prunes, each through its own
 * configuration. Rejects as `pruneTenantForgetLedger` does when there is nothing to prune, and
 * with `ConfigurationError` for a ledger of your own without `tenants`.
 */
export const listForgetLedgerTenants: ListForgetLedgerTenantsFunction = async ({
  config,
  env = {},
  tenant,
}) => {
  const { ledger } = await prunable({ config, env, tenant: tenantIdOf(tenant) });
  try {
    if (ledger.tenants === undefined) {
      throw refused(
        "The forget ledger cannot list its tenants: give it tenants(), or prune each tenant by name",
      );
    }
    return await ledger.tenants();
  } finally {
    await ledger.close?.();
  }
};
