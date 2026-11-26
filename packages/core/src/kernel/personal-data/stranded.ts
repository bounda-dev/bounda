import { isAdapter } from "../../adapter/adapter.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import { configForTenant } from "../../config/define-config.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { ProjectConfig } from "../../config/types.ts";
import type { Registry } from "../../modules/registry.ts";
import type { AppEnv } from "../../register/index.ts";
import { tenantIdOf } from "../tenant.ts";
import { type ForgetLedgerSource, openForgetLedger, physicalStoreOf } from "./forget-ledger.ts";
import {
  type ReconciliationRules,
  readFromOf,
  reconciliationRulesOf,
  refused,
  strandedEntries,
  withTenantStorage,
} from "./ledger-prune.ts";
import { FORGET_LEDGER_CURSOR } from "./reconciliation.ts";
import { reachTenants, type UnreachedTenant } from "./tenant-reach.ts";

export interface ListStrandedForgetLedgerEntriesArgs {
  /**
   * What `bounda.config.ts` exports, as `loadProject` gives it in `projectConfig`.
   */
  readonly config: ProjectConfig;
  /**
   * The project's registry, as `loadProject` gives it: what decides, as the app's reconciliation
   * does, whether an entry still applies.
   */
  readonly registry: Registry;
  /**
   * The environment the forget ledgers, the key wrapper and the tenant key stores read, such as
   * `process.env`. Defaults to none.
   */
  readonly env?: AppEnv;
  /**
   * The tenant whose entries to list. Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
  /**
   * Tenants to reach beside those the stores list, as the `tenants` export of `bounda.config.ts`
   * names them: their configurations may name stores that hold the tenant's entries.
   */
  readonly tenants?: readonly string[];
  /**
   * Defaults to the current time.
   */
  readonly now?: Date;
}

export interface StrandedForgetLedgerEntries {
  readonly tenant: string;
  /**
   * The entries, each once: of the ledger the configuration names, then of every other store
   * reached, each in the ledger's order.
   */
  readonly entries: readonly ForgetLedgerEntry[];
  /**
   * The tenants reached whose stores could not be listed: a store only they name may hold entries
   * `entries` lacks.
   */
  readonly unreached: readonly UnreachedTenant[];
}

export interface ListStrandedForgetLedgerEntriesFunction {
  (args: ListStrandedForgetLedgerEntriesArgs): Promise<StrandedForgetLedgerEntries>;
}

interface ReachedStore {
  readonly source: ForgetLedgerSource;
  readonly store: unknown;
}

/**
 * The entries of a tenant no app of it applies: what `bounda forget-ledger stranded` prints, for
 * `bounda forget-ledger apply` to apply again. An entry is listed when the tenant's database lacks
 * what it records, something would still apply it, as the app's reconciliation decides with the
 * registry, and no reconciliation reads it: it is in a store the configuration no longer names, as
 * one it named before its ledger moved, and the ledger it names lacks it, or holds it only from
 * before where the database's reconciliation reads; or it is in that ledger, before there. A
 * forgetting for inactivity is left to the retention, which decides it again on its own. Every
 * store reached as `listForgetLedgerTenants` reaches them is read for the tenant's entries, and
 * the tenant's database is opened as `migrateTables` opens it. Rejects with `ConfigurationError`
 * without a forget ledger, for a storage only its host opens, and for a registry the app refuses
 * at its start.
 */
export const listStrandedForgetLedgerEntries: ListStrandedForgetLedgerEntriesFunction = async ({
  config,
  registry,
  env = {},
  tenant: asked,
  tenants = [],
  now = new Date(),
}) => {
  const tenant = tenantIdOf(asked);
  const tenantConfig = configForTenant({ config, tenant });
  const resolved = resolveConfig(tenantConfig);
  const ledgerConfig = resolved.runtime.personalData.forgetLedger;
  if (ledgerConfig === null) {
    throw refused("Listing stranded entries needs runtime.personalData.forgetLedger");
  }
  const { storage } = resolved;
  if (!isAdapter(storage)) {
    throw refused(
      "The storage is opened only by its host, as a Durable Object's is: its app applies the forget ledger",
    );
  }
  const reached: ReachedStore[] = [];
  const { ledgers, unreached } = await reachTenants({
    config,
    env,
    first: tenant,
    firstConfig: tenantConfig,
    tenants,
    listLedger: async (ledger, source, store) => {
      reached.push({ source, store });
      // A store that cannot list its tenants is read for this tenant's entries all the same.
      return (await ledger.tenants?.()) ?? [];
    },
  });
  const own = ledgers.get(tenant);
  const keepForMs = ledgerConfig.keepForMs ?? undefined;
  const open = (source: ForgetLedgerSource): Promise<ForgetLedger> =>
    openForgetLedger({ source, storage, env, tenant, keepForMs });
  let rules: ReconciliationRules | undefined;
  const named = await open(ledgerConfig.store);
  try {
    const entries = await withTenantStorage({
      config: tenantConfig,
      env,
      tenant,
      work: async (database) => {
        const readFrom = readFromOf(
          database === null ? 0 : await database.checkpointStore.get(FORGET_LEDGER_CURSOR),
        );
        const listed = (ledger: ForgetLedger, followed: boolean) =>
          strandedEntries({
            storage: database,
            rules: () => {
              rules ??= reconciliationRulesOf({ registry, config: resolved });
              return rules;
            },
            now,
            ledger,
            named: followed ? null : named,
            readFrom,
            limit: Number.POSITIVE_INFINITY,
          });
        const found = [...(await listed(named, true))];
        const seen = new Set(found.map(({ eventId }) => eventId));
        for (const { source, store } of reached) {
          if (store === own) continue;
          const ledger = await open(source);
          try {
            // A definition read as another store may open the named one for this tenant.
            if (physicalStoreOf(ledger, source) === own) continue;
            for (const entry of await listed(ledger, false)) {
              if (seen.has(entry.eventId)) continue;
              seen.add(entry.eventId);
              found.push(entry);
            }
          } finally {
            await ledger.close?.();
          }
        }
        return found;
      },
    });
    return { tenant, entries, unreached };
  } finally {
    await named.close?.();
  }
};
