import { byCodeUnit } from "../../adapter/storage/forget-ledger.ts";
import { configForTenant } from "../../config/define-config.ts";
import type { ProjectConfig } from "../../config/types.ts";
import type { AppEnv } from "../../register/index.ts";
import { tenantIdOf } from "../tenant.ts";
import type { ForgetLedgerSource } from "./forget-ledger.ts";
import { prunable, refused } from "./ledger-prune.ts";
import { reachTenants, type UnreachedTenant } from "./tenant-reach.ts";

export interface ListForgetLedgerTenantsArgs {
  /**
   * What `bounda.config.ts` exports, as `loadProject` gives it in `projectConfig`: one
   * configuration, or a function of the tenant, called for every tenant reached.
   */
  readonly config: ProjectConfig;
  /**
   * The environment the forget ledgers and the tenant key stores read, such as `process.env`.
   * Defaults to none.
   */
  readonly env?: AppEnv;
  /**
   * The tenant to start from, whose configuration must name a forget ledger an operator prunes.
   * Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
  /**
   * Tenants to reach beside those the stores list, as the `tenants` export of `bounda.config.ts`
   * names them, `loadProject`'s `tenants()`.
   */
  readonly tenants?: readonly string[];
}

export interface ForgetLedgerStore {
  /**
   * The store, as the configuration of the first tenant reached that names it gives it: what
   * `pruneTenantForgetLedger` takes as `store`.
   */
  readonly store: ForgetLedgerSource;
  /**
   * The tenants whose entries it holds, in code-unit order.
   */
  readonly tenants: readonly string[];
  /**
   * The tenants reached whose configuration names it, in code-unit order: a tenant it holds that
   * is not here named it before its ledger moved. Definitions a function of the tenant makes anew
   * name one store when their ledgers give one `storeId`, as an adapter's do.
   */
  readonly named: readonly string[];
}

export interface ForgetLedgerTenants {
  /**
   * Every tenant whose entries a forget ledger's store the configuration names holds, in code-unit
   * order.
   */
  readonly tenants: readonly string[];
  /**
   * Every store read that holds a tenant's entries, in the order read: a tenant's entries in one
   * its configuration no longer names, as one it named before the ledger moved, are pruned there.
   */
  readonly stores: readonly ForgetLedgerStore[];
  /**
   * The tenants reached whose stores could not be listed: a store only they name may hold tenants
   * `tenants` lacks.
   */
  readonly unreached: readonly UnreachedTenant[];
}

export interface ListForgetLedgerTenantsFunction {
  (args: ListForgetLedgerTenantsArgs): Promise<ForgetLedgerTenants>;
}

/**
 * Every tenant whose entries a forget ledger's store the configuration can name holds: what
 * `bounda forget-ledger prune --all-tenants` prunes, each through its own configuration. It starts
 * from `tenant` and those `tenants` names, and reaches every tenant the forget ledger's store and
 * the tenant key store of each reached tenant's configuration list, until none is new, reading
 * each store once, opened as an app opens it, which creates its table where it is missing: an
 * adapter of one kind with the same options is one store, and so are ledgers that give one
 * `storeId`, as an adapter's do, whichever definition opens them, a function of the tenant that
 * makes one anew for every tenant included; a ledger of your own without it is one store per
 * definition. A database that holds both a forget ledger and tenant keys is read as both. A
 * configuration that gives each tenant both stores of its own names its tenants in `tenants`.
 * Rejects as `pruneTenantForgetLedger` does when the starting tenant has nothing to prune, with
 * `ConfigurationError` when its ledger cannot list its tenants, and when its stores cannot be read;
 * any other tenant whose stores cannot be read is in `unreached`.
 */
export const listForgetLedgerTenants: ListForgetLedgerTenantsFunction = async ({
  config,
  env = {},
  tenant: named,
  tenants: listed = [],
}) => {
  const first = tenantIdOf(named);
  const firstConfig = configForTenant({ config, tenant: first });
  const { ledger, source } = await prunable({ config: firstConfig, env, tenant: first });
  const held: {
    readonly store: ForgetLedgerSource;
    readonly physical: unknown;
    readonly tenants: readonly string[];
  }[] = [];
  const { inLedgers, ledgers, unreached } = await reachTenants({
    config,
    env,
    first,
    firstConfig,
    firstLedger: { ledger, source },
    tenants: listed,
    listLedger: async (each, store, physical) => {
      // A ledger that expires its entries on its own has nothing to prune.
      if (each.tenants === undefined && each.prune !== undefined) {
        throw refused(
          "The forget ledger cannot list its tenants: give it tenants(), or prune each tenant by name",
        );
      }
      const tenants = (await each.tenants?.()) ?? [];
      if (tenants.length > 0) {
        held.push({ store, physical, tenants: [...tenants].sort(byCodeUnit) });
      }
      return tenants;
    },
  });
  // The tenants reached whose configuration names the store.
  const namedBy = (physical: unknown): readonly string[] =>
    [...ledgers]
      .filter(([, store]) => store === physical)
      .map(([tenant]) => tenant)
      .sort(byCodeUnit);
  return {
    tenants: [...inLedgers].sort(byCodeUnit),
    stores: held.map(({ store, physical, tenants }) => ({
      store,
      tenants,
      named: namedBy(physical),
    })),
    unreached,
  };
};
