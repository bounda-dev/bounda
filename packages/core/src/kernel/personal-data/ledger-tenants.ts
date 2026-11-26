import { isAdapter } from "../../adapter/adapter.ts";
import { byCodeUnit, type ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import { configForTenant } from "../../config/define-config.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config, ProjectConfig } from "../../config/types.ts";
import type { AppEnv } from "../../register/index.ts";
import { tenantIdOf } from "../tenant.ts";
import { type ForgetLedgerSource, openForgetLedger } from "./forget-ledger.ts";
import { keySourcesOf } from "./key-hierarchy.ts";
import { prunable, refused } from "./ledger-prune.ts";
import { openTenantKeyStore, type TenantKeySource } from "./tenant-key-source.ts";

// How many tenants a page of a tenant key store lists.
const PAGE = 500;

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

export interface UnreachedTenant {
  readonly tenant: string;
  /**
   * Why its configuration, its forget ledger's store or its tenant key store could not be read.
   */
  readonly error: unknown;
}

export interface ForgetLedgerTenants {
  /**
   * Every tenant whose entries a forget ledger's store the configuration names holds, in code-unit
   * order.
   */
  readonly tenants: readonly string[];
  /**
   * The tenants reached whose stores could not be listed: a store only they name may hold tenants
   * `tenants` lacks.
   */
  readonly unreached: readonly UnreachedTenant[];
}

export interface ListForgetLedgerTenantsFunction {
  (args: ListForgetLedgerTenantsArgs): Promise<ForgetLedgerTenants>;
}

// One database is one store, whichever tenant's configuration names it: an adapter of the same kind
// with the same options, as `sharesStorage` reads it, or the same definition. Every memory adapter
// is a store of its own.
const storeOf = (source: ForgetLedgerSource | TenantKeySource): unknown => {
  if (source.kind !== "bounda-adapter" || source.name === "memory") return source;
  try {
    return `${source.name}:${JSON.stringify(source.options)}`;
  } catch {
    // Options JSON cannot write, such as a client of your own, tell the adapter by itself.
    return source;
  }
};

/**
 * Every tenant whose entries a forget ledger's store the configuration can name holds: what
 * `bounda forget-ledger prune --all-tenants` prunes, each through its own configuration. It starts
 * from `tenant` and those `tenants` names, and reaches every tenant the forget ledger's store and
 * the tenant key store of each reached tenant's configuration list, until none is new, reading
 * each store once, opened as an app opens it, which creates its table where it is missing: an
 * adapter of one kind with the same options is one store, and so is one
 * definition, which a function of the tenant that defines a store inside it makes anew for every
 * tenant. A configuration that gives each tenant both stores of its own names its tenants in
 * `tenants`. Rejects as `pruneTenantForgetLedger` does when the starting tenant has nothing to
 * prune, with `ConfigurationError` when its ledger cannot list its tenants, and when its stores
 * cannot be read; any other tenant whose stores cannot be read is in `unreached`.
 */
export const listForgetLedgerTenants: ListForgetLedgerTenantsFunction = async ({
  config,
  env = {},
  tenant: named,
  tenants: listed = [],
}) => {
  const reached = new Set<string>();
  const queue: string[] = [];
  const reach = (tenant: string): void => {
    if (reached.has(tenant)) return;
    reached.add(tenant);
    queue.push(tenant);
  };
  const read = new Set<unknown>();
  const found = new Set<string>();
  const listLedger = async (ledger: ForgetLedger): Promise<void> => {
    try {
      // A ledger that expires its entries on its own has nothing to prune.
      if (ledger.tenants === undefined && ledger.prune !== undefined) {
        throw refused(
          "The forget ledger cannot list its tenants: give it tenants(), or prune each tenant by name",
        );
      }
      for (const each of (await ledger.tenants?.()) ?? []) {
        found.add(each);
        reach(each);
      }
    } finally {
      await ledger.close?.();
    }
  };
  const listTenantKeys = async (config: Config): Promise<void> => {
    const resolved = resolveConfig(config);
    const { storage, runtime } = resolved;
    const source = isAdapter(storage)
      ? keySourcesOf({ storage, personalData: runtime.personalData }).tenantKeys
      : runtime.personalData.tenantKeys;
    if (source === null || read.has(storeOf(source))) return;
    read.add(storeOf(source));
    const store = await openTenantKeyStore({ source, storage, env });
    try {
      let cursor: string | null = null;
      do {
        const page = await store.list({ cursor, limit: PAGE });
        for (const each of page.tenants) reach(each);
        cursor = page.cursor;
      } while (cursor !== null);
    } finally {
      await store.close?.();
    }
  };

  const first = tenantIdOf(named);
  const firstConfig = configForTenant({ config, tenant: first });
  const { ledger, source } = await prunable({ config: firstConfig, env, tenant: first });
  reached.add(first);
  read.add(storeOf(source));
  await listLedger(ledger);
  await listTenantKeys(firstConfig);
  for (const tenant of listed) reach(tenantIdOf(tenant));

  const unreached: UnreachedTenant[] = [];
  for (let tenant = queue.shift(); tenant !== undefined; tenant = queue.shift()) {
    try {
      const tenantConfig = configForTenant({ config, tenant });
      const { storage, runtime } = resolveConfig(tenantConfig);
      const { forgetLedger } = runtime.personalData;
      if (forgetLedger !== null && !read.has(storeOf(forgetLedger.store))) {
        read.add(storeOf(forgetLedger.store));
        await listLedger(
          await openForgetLedger({
            source: forgetLedger.store,
            storage,
            env,
            tenant,
            keepForMs: forgetLedger.keepForMs ?? undefined,
          }),
        );
      }
      await listTenantKeys(tenantConfig);
    } catch (error) {
      unreached.push({ tenant, error });
    }
  }
  return { tenants: [...found].sort(byCodeUnit), unreached };
};
