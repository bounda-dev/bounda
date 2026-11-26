import { isAdapter } from "../../adapter/adapter.ts";
import type { AdapterDefinition } from "../../adapter/adapter-definition.ts";
import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import { configForTenant } from "../../config/define-config.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config, ProjectConfig, ResolvedConfig } from "../../config/types.ts";
import type { AppEnv } from "../../register/index.ts";
import { tenantIdOf } from "../tenant.ts";
import {
  type ForgetLedgerSource,
  openForgetLedger,
  physicalStoreOf,
  storeOf,
} from "./forget-ledger.ts";
import { keySourcesOf } from "./key-hierarchy.ts";
import { openTenantKeyStore, type TenantKeySource } from "./tenant-key-source.ts";

// How many tenants a page of a tenant key store lists.
const PAGE = 500;

export interface UnreachedTenant {
  readonly tenant: string;
  /**
   * Why its configuration, its forget ledger's store or its tenant key store could not be read.
   */
  readonly error: unknown;
}

export interface OpenedForgetLedger {
  readonly ledger: ForgetLedger;
  readonly source: ForgetLedgerSource;
}

export interface ReachedKeyStore {
  readonly source: TenantKeySource;
  // The storage of the configuration it was read through, which opening it checks it against.
  readonly storage: AdapterDefinition;
  readonly tenants: readonly string[];
}

export interface ReachTenantsArgs {
  readonly config: ProjectConfig;
  readonly env: AppEnv;
  readonly first: string;
  readonly firstConfig: Config;
  // The first tenant's forget ledger, opened as the caller requires it; closed once read.
  readonly firstLedger?: OpenedForgetLedger;
  readonly tenants: readonly string[];
  // The tenants a forget ledger's store lists, `store` as `physicalStoreOf` tells it: the caller
  // decides what one that cannot list means.
  readonly listLedger: (
    ledger: ForgetLedger,
    source: ForgetLedgerSource,
    store: unknown,
  ) => Promise<readonly string[]>;
}

export interface ReachedTenants {
  // Every tenant reached whose configuration resolved, though its stores could not be read.
  readonly configs: ReadonlyMap<string, ResolvedConfig>;
  readonly inLedgers: ReadonlySet<string>;
  // The store, as `physicalStoreOf` tells it, of the forget ledger each reached tenant's
  // configuration names.
  readonly ledgers: ReadonlyMap<string, unknown>;
  // In the order read: the first tenant's first.
  readonly keyStores: readonly ReachedKeyStore[];
  readonly unreached: readonly UnreachedTenant[];
}

export interface ReachTenantsFunction {
  (args: ReachTenantsArgs): Promise<ReachedTenants>;
}

const firstRead = (read: Set<unknown>, source: ForgetLedgerSource | TenantKeySource): boolean => {
  const store = storeOf(source);
  if (read.has(store)) return false;
  read.add(store);
  return true;
};

// Each store is read once, by what it is: an adapter's, which is one store whichever tenant opens
// it, before it is opened, and a definition's, which may open another for every tenant, once it is,
// by what its ledger says. A database that holds a forget ledger and tenant keys is read as both,
// since each lists other tenants. What fails for the first tenant rejects; any other tenant's
// failure is in `unreached`.
export const reachTenants: ReachTenantsFunction = async ({
  config,
  env,
  first,
  firstConfig,
  firstLedger,
  tenants,
  listLedger,
}) => {
  const reached = new Set<string>([first]);
  const queue: string[] = [];
  const reach = (tenant: string): void => {
    if (reached.has(tenant)) return;
    reached.add(tenant);
    queue.push(tenant);
  };
  const ledgersRead = new Set<unknown>();
  // Of each adapter read, the store its ledgers keep their entries in.
  const adapterStores = new Map<unknown, unknown>();
  const ledgers = new Map<string, unknown>();
  const keysRead = new Set<unknown>();
  const configs = new Map<string, ResolvedConfig>();
  const inLedgers = new Set<string>();
  const keyStores: ReachedKeyStore[] = [];

  // Lists the ledger's store, unless read already, and closes the ledger.
  const readLedger = async (tenant: string, { ledger, source }: OpenedForgetLedger) => {
    try {
      const store = physicalStoreOf(ledger, source);
      if (source.kind === "bounda-adapter") adapterStores.set(storeOf(source), store);
      ledgers.set(tenant, store);
      if (ledgersRead.has(store)) return;
      ledgersRead.add(store);
      for (const each of await listLedger(ledger, source, store)) {
        inLedgers.add(each);
        reach(each);
      }
    } finally {
      await ledger.close?.();
    }
  };
  const readTenantKeys = async ({ storage, runtime }: ResolvedConfig): Promise<void> => {
    const source = isAdapter(storage)
      ? keySourcesOf({ storage, personalData: runtime.personalData }).tenantKeys
      : runtime.personalData.tenantKeys;
    if (source === null || !firstRead(keysRead, source)) return;
    const store = await openTenantKeyStore({ source, storage, env });
    const listed: string[] = [];
    try {
      let cursor: string | null = null;
      do {
        const page = await store.list({ cursor, limit: PAGE });
        for (const each of page.tenants) {
          listed.push(each);
          reach(each);
        }
        cursor = page.cursor;
      } while (cursor !== null);
    } finally {
      await store.close?.();
    }
    keyStores.push({ source, storage, tenants: listed });
  };
  const visit = async (tenant: string, tenantConfig: Config, ledgerRead = false) => {
    const resolved = resolveConfig(tenantConfig);
    configs.set(tenant, resolved);
    await readTenantKeys(resolved);
    const { forgetLedger } = resolved.runtime.personalData;
    if (forgetLedger === null || ledgerRead) return;
    const { store: source } = forgetLedger;
    const known = source.kind === "bounda-adapter" ? adapterStores.get(storeOf(source)) : undefined;
    if (known !== undefined) {
      ledgers.set(tenant, known);
      return;
    }
    await readLedger(tenant, {
      ledger: await openForgetLedger({
        source,
        storage: resolved.storage,
        env,
        tenant,
        keepForMs: forgetLedger.keepForMs ?? undefined,
      }),
      source,
    });
  };

  if (firstLedger === undefined) {
    await visit(first, firstConfig);
  } else {
    try {
      await visit(first, firstConfig, true);
    } catch (error) {
      await firstLedger.ledger.close?.();
      throw error;
    }
    await readLedger(first, firstLedger);
  }
  for (const tenant of tenants) reach(tenantIdOf(tenant));

  const unreached: UnreachedTenant[] = [];
  // An array's iterator reads its length at every step, so this goes on through what `reach` adds.
  for (const tenant of queue) {
    try {
      await visit(tenant, configForTenant({ config, tenant }));
    } catch (error) {
      unreached.push({ tenant, error });
    }
  }
  return { configs, inLedgers, ledgers, keyStores, unreached };
};
