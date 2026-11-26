import type { AdapterDefinition } from "../../adapter/adapter-definition.ts";
import { byCodeUnit } from "../../adapter/storage/forget-ledger.ts";
import type {
  StoredFileKey,
  TenantKeyStore,
  VersionedTenantKeyRecord,
} from "../../adapter/storage/tenant-key-store.ts";
import { configForTenant } from "../../config/define-config.ts";
import type { ProjectConfig, ProjectTenants, ResolvedConfig } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { tenantIdOf } from "../tenant.ts";
import { storeOf } from "./forget-ledger.ts";
import { mastersIn, underPrevious, wrappingMasters } from "./master-rotation.ts";
import { openTenantKeyStore, type TenantKeySource } from "./tenant-key-source.ts";
import {
  type ReachedKeyStore,
  reachTenants,
  tenantKeySourceOf,
  type UnreachedTenant,
} from "./tenant-reach.ts";

// How many times a removal that lost the race to another writer reads both records again.
const REMOVE_ATTEMPTS = 5;

/**
 * What the tenant key store a tenant's own configuration names holds of it, against a copy of its
 * record in another store: its `forgotten` forgetting, every key the copy holds (`holds`), not all
 * of them (`differs`), or no record at all, or the configuration names no store (`lacks`).
 */
export type NamedTenantKeys = "forgotten" | "holds" | "differs" | "lacks";

/**
 * A tenant's record in a tenant key store its own configuration does not name, as a move of the
 * tenant to another store leaves behind.
 */
export interface StaleTenantKey {
  readonly tenant: string;
  /**
   * A tenant whose configuration names the store that holds the copy: the first it was reached
   * through.
   */
  readonly namedBy: string;
  readonly named: NamedTenantKeys;
  /**
   * What the copy holds and the record in the store the tenant's configuration names does not: the
   * ids of versions of its key, and of keys of its database files. Removing the copy leaves what
   * was encrypted under them unreadable.
   */
  readonly lost: {
    readonly versions: readonly string[];
    readonly files: readonly string[];
  };
}

/**
 * A tenant whose record a reached store holds, and that could not be read or judged.
 */
export interface FailedTenantKey {
  readonly tenant: string;
  readonly error: unknown;
}

export interface TenantKeyStoresArgs {
  /**
   * What `bounda.config.ts` exports, as `loadProject` gives it in `projectConfig`: one
   * configuration, or a function of the tenant, called for every tenant reached.
   */
  readonly config: ProjectConfig;
  /**
   * The environment the key wrappers and the stores read, such as `process.env`.
   */
  readonly env: AppEnv;
  /**
   * The tenant to start from. Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
  /**
   * Tenants to reach beside those the stores list, as the `tenants` export of `bounda.config.ts`
   * names them, `loadProject`'s `tenants()`.
   */
  readonly tenants?: readonly string[];
}

/**
 * What every tenant key store the configuration can name holds, as `inspectTenantKeys` reads it.
 */
export interface TenantKeysInspection {
  /**
   * How many tenant key stores were read.
   */
  readonly stores: number;
  /**
   * The tenants a version of whose key, in any store read, or a key of whose files a forgetting
   * keeps, is wrapped under another master key than their configuration's in force, in code-unit
   * order: what `rewrapTenantKeys` has left to rewrap, and what must be none before the previous
   * master keys go.
   */
  readonly underPreviousMaster: readonly string[];
  /**
   * Every copy of a tenant's record in a store its configuration does not name, by tenant in
   * code-unit order.
   */
  readonly stale: readonly StaleTenantKey[];
  /**
   * The tenants whose record could not be read or judged, in code-unit order.
   */
  readonly failed: readonly FailedTenantKey[];
  /**
   * The tenants reached whose configuration or stores could not be read: a store only they name
   * may hold more.
   */
  readonly unreached: readonly UnreachedTenant[];
}

export interface InspectTenantKeysFunction {
  (args: TenantKeyStoresArgs): Promise<TenantKeysInspection>;
}

export interface RemoveStaleTenantKeysArgs extends TenantKeyStoresArgs {
  /**
   * The tenants whose copies to remove; every tenant's without it.
   */
  readonly only?: readonly string[];
  /**
   * Removes a copy that holds keys the store the tenant's configuration names lacks, as versions
   * retired there since it was copied: what was encrypted under them, a backup or the database the
   * copy belonged to, opens no more. Without it such a copy is refused.
   */
  readonly despiteLostKeys?: boolean;
}

/**
 * A copy of a tenant's record that could not be removed, and why.
 */
export interface RefusedStaleTenantKey {
  readonly tenant: string;
  readonly namedBy: string;
  readonly error: unknown;
}

export interface RemovedStaleTenantKeys {
  /**
   * The copies removed, by tenant in code-unit order.
   */
  readonly removed: readonly StaleTenantKey[];
  /**
   * The copies left, and the tenants whose record could not be read, by tenant in code-unit order.
   */
  readonly refused: readonly RefusedStaleTenantKey[];
  /**
   * The tenants reached whose configuration or stores could not be read: a store only they name
   * may hold copies too.
   */
  readonly unreached: readonly UnreachedTenant[];
}

export interface RemoveStaleTenantKeysFunction {
  (args: RemoveStaleTenantKeysArgs): Promise<RemovedStaleTenantKeys>;
}

const keyOf = (first: string, second: string): string => `${first}\u0000${second}`;

const fileKeysOf = (record: VersionedTenantKeyRecord): readonly StoredFileKey[] => [
  ...(record.files ?? []),
  ...(record.forgotten?.files ?? []),
];

// A version is the same key only under the same id and check value; a file key, the same database's
// key under the same id.
const judge = (
  tenant: string,
  namedBy: string,
  copy: VersionedTenantKeyRecord,
  named: VersionedTenantKeyRecord | null,
): StaleTenantKey => {
  const versions = new Set(named?.keys.map(({ kid, fingerprint }) => keyOf(kid, fingerprint)));
  const files = new Set(
    named === null ? [] : fileKeysOf(named).map(({ database, id }) => keyOf(database, id)),
  );
  const lost = {
    versions: copy.keys
      .filter(({ kid, fingerprint }) => !versions.has(keyOf(kid, fingerprint)))
      .map(({ kid }) => kid),
    files: fileKeysOf(copy)
      .filter(({ database, id }) => !files.has(keyOf(database, id)))
      .map(({ id }) => id),
  };
  const state: NamedTenantKeys =
    named === null
      ? "lacks"
      : named.forgotten !== null
        ? "forgotten"
        : lost.versions.length === 0 && lost.files.length === 0
          ? "holds"
          : "differs";
  return { tenant, namedBy, named: state, lost };
};

interface Walked {
  readonly configs: ReadonlyMap<string, ResolvedConfig>;
  readonly keyStores: readonly ReachedKeyStore[];
  readonly unreached: readonly UnreachedTenant[];
  // Each store opened once, by identity, and closed by `close`.
  readonly open: (source: TenantKeySource, storage: AdapterDefinition) => Promise<TenantKeyStore>;
  readonly close: () => Promise<void>;
}

const walk = async ({
  config,
  env,
  tenant: named,
  tenants = [],
}: TenantKeyStoresArgs): Promise<Walked> => {
  const first = tenantIdOf(named);
  const { configs, keyStores, unreached } = await reachTenants({
    config,
    env,
    first,
    firstConfig: configForTenant({ config, tenant: first }),
    tenants,
    // A ledger that cannot list its tenants only adds none to reach.
    listLedger: async (ledger) => (await ledger.tenants?.()) ?? [],
  });
  const opened = new Map<unknown, Promise<TenantKeyStore>>();
  return {
    configs,
    keyStores,
    unreached,
    open: (source, storage) => {
      const store = storeOf(source);
      const known = opened.get(store);
      if (known !== undefined) return known;
      const opening = openTenantKeyStore({ source, storage, env });
      opened.set(store, opening);
      return opening;
    },
    close: async () => {
      for (const opening of opened.values()) {
        await opening.then(
          (store) => store.close?.(),
          () => undefined,
        );
      }
    },
  };
};

interface Owned {
  readonly tenant: string;
  readonly resolved: ResolvedConfig;
  // The store its configuration names, `null` for none.
  readonly named: TenantKeySource | null;
  // Whether `named` is another store than the one its record was found in.
  readonly stale: boolean;
}

// The tenants a store lists whose configuration resolved: the others are in `unreached` already.
const ownedIn = (
  { source, tenants }: ReachedKeyStore,
  configs: ReadonlyMap<string, ResolvedConfig>,
): readonly Owned[] =>
  tenants.flatMap((tenant) => {
    const resolved = configs.get(tenant);
    if (resolved === undefined) return [];
    const named = tenantKeySourceOf(resolved);
    return [
      { tenant, resolved, named, stale: named === null || storeOf(named) !== storeOf(source) },
    ];
  });

const namedRecord = async (
  walked: Walked,
  { tenant, resolved, named }: Owned,
): Promise<VersionedTenantKeyRecord | null> =>
  named === null ? null : (await walked.open(named, resolved.storage)).get(tenant);

const byTenant = <T extends { readonly tenant: string }>(list: T[]): T[] =>
  list.sort((a, b) => byCodeUnit(a.tenant, b.tenant));

const NO_WRAPPER = (tenant: string): ConfigurationError =>
  runtimeText(
    new ConfigurationError(
      `Tenant ${tenant}'s key is wrapped under a master key, and its configuration names no runtime.personalData.keyWrapper`,
    ),
  );

/**
 * Reads every tenant key store the configuration can name, writing nothing: the tenants whose keys
 * a rotation of the master key has left under a previous one, and every copy of a tenant's record
 * in a store its configuration does not name. What `bounda tenant-key status` prints. It starts
 * from `tenant` and those `tenants` names, and reaches every tenant the tenant key store and the
 * forget ledger's store of each reached tenant's configuration list, as `rewrapTenantKeys` does,
 * reading each store once; each tenant's record is judged against its own configuration's key
 * wrapper. Rejects when the starting tenant's stores cannot be listed; any other failure is in
 * `failed` or `unreached`.
 */
export const inspectTenantKeys: InspectTenantKeysFunction = async (args) => {
  const walked = await walk(args);
  const masterOf = mastersIn(args.env);
  const under = new Set<string>();
  const stale: StaleTenantKey[] = [];
  const failed = new Map<string, unknown>();
  const fail = (tenant: string, error: unknown): void => {
    if (!failed.has(tenant)) failed.set(tenant, error);
  };
  try {
    for (const reached of walked.keyStores) {
      const owned = ownedIn(reached, walked.configs);
      let store: TenantKeyStore;
      try {
        store = await walked.open(reached.source, reached.storage);
      } catch (error) {
        for (const { tenant } of owned) fail(tenant, error);
        continue;
      }
      for (const each of owned) {
        const { tenant, resolved } = each;
        try {
          const record = await store.get(tenant);
          if (record === null) continue;
          const definition = resolved.runtime.personalData.keyWrapper;
          if (definition === null) {
            if (wrappingMasters(record).length > 0) fail(tenant, NO_WRAPPER(tenant));
          } else if (underPrevious(record, await masterOf(definition))) {
            under.add(tenant);
          }
          if (each.stale) {
            stale.push(judge(tenant, reached.namedBy, record, await namedRecord(walked, each)));
          }
        } catch (error) {
          fail(tenant, error);
        }
      }
    }
  } finally {
    await walked.close();
  }
  return {
    stores: walked.keyStores.length,
    underPreviousMaster: [...under].sort(byCodeUnit),
    stale: byTenant(stale),
    failed: byTenant([...failed].map(([tenant, error]) => ({ tenant, error }))),
    unreached: walked.unreached,
  };
};

const refusal = (message: string): ConfigurationError =>
  runtimeText(new ConfigurationError(message));

const where = ({ tenant, namedBy }: Pick<StaleTenantKey, "tenant" | "namedBy">): string =>
  `The copy of tenant ${tenant}'s key in the tenant key store ${namedBy}'s configuration names`;

const refuseLost = (judged: StaleTenantKey, despite: boolean): void => {
  const { tenant, named, lost } = judged;
  if (named !== "differs" || despite) return;
  const held = [
    ...(lost.versions.length === 0 ? [] : [`versions ${lost.versions.join(", ")}`]),
    ...(lost.files.length === 0 ? [] : [`file keys ${lost.files.join(", ")}`]),
  ].join(" and ");
  throw refusal(
    `${where(judged)} holds ${held}, which the store ${tenant}'s own configuration names lacks: what was encrypted under them opens with nothing else. Remove it despite them only once nothing needs them`,
  );
};

// Proves the two stores apart before removing: a store told apart from another only as two
// definitions, or by options JSON cannot write, may be the same one, and removing the copy would
// then remove the tenant's own record. Writing the copy again over its revision moves the named
// record's revision too exactly when they are one store.
const removeCopy = async (
  store: TenantKeyStore,
  namedStore: () => Promise<TenantKeyStore | null>,
  { tenant, namedBy }: Pick<StaleTenantKey, "tenant" | "namedBy">,
  despite: boolean,
): Promise<StaleTenantKey | null> => {
  if (store.oneWriterPerTenant === true) {
    throw refusal(
      `The copy of tenant ${tenant}'s key is in the tenant key store ${namedBy}'s configuration names, which each tenant's own writer alone writes, as KV is: nothing else may remove it, so remove it there by hand once the store ${tenant}'s configuration names holds the same key`,
    );
  }
  const other = await namedStore();
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    const copy = await store.get(tenant);
    if (copy === null) return null;
    const named = other === null ? null : { store: other, record: await other.get(tenant) };
    const judged = judge(tenant, namedBy, copy, named?.record ?? null);
    if (named === null || named.record === null) {
      throw refusal(
        `${where(judged)} is the only one: the store ${tenant}'s own configuration names holds no record of it, so removing it would leave its data nothing to open with`,
      );
    }
    refuseLost(judged, despite);
    const { revision, ...held } = copy;
    if (!(await store.put(tenant, held, revision))) continue;
    const again = await named.store.get(tenant);
    if (again?.revision === named.record.revision) {
      if (await store.remove(tenant, revision + 1)) return judged;
      continue;
    }
    if (again?.revision === revision + 1) {
      throw refusal(
        `The tenant key store ${namedBy}'s configuration names and the one ${tenant}'s names answer as one store, told apart only by how each configuration builds it: ${tenant}'s record there stays`,
      );
    }
  }
  throw refusal(
    `Tenant ${tenant}'s records kept changing while its copy in the tenant key store ${namedBy}'s configuration names was removed`,
  );
};

/**
 * Removes every copy of a tenant's record left in a tenant key store its configuration no longer
 * names, as a move to another store leaves one: a copy of its key that a forgetting, which reaches
 * only the named store, would leave behind. What `bounda tenant-key remove-stale` runs, and what
 * `forgetTenant` runs for its own tenant in an app given `project`. It reaches the stores as
 * `inspectTenantKeys` does. A copy is removed only once the named store holds the tenant's
 * forgetting, or every key the copy holds, unless `despiteLostKeys`; never while the named store
 * holds no record of the tenant, nor from a store each tenant's own writer alone writes, as KV is;
 * and only once the two stores are proven apart. Rejects when the starting tenant's stores cannot
 * be listed; any other failure is in `refused` or `unreached`.
 */
export const removeStaleTenantKeys: RemoveStaleTenantKeysFunction = async ({
  only,
  despiteLostKeys = false,
  ...args
}) => {
  const walked = await walk(args);
  const wanted = only === undefined ? null : new Set(only.map((tenant) => tenantIdOf(tenant)));
  const removed: StaleTenantKey[] = [];
  const refused: RefusedStaleTenantKey[] = [];
  try {
    for (const reached of walked.keyStores) {
      const { namedBy } = reached;
      const owned = ownedIn(reached, walked.configs).filter(
        ({ tenant, stale }) => stale && (wanted === null || wanted.has(tenant)),
      );
      let store: TenantKeyStore;
      try {
        store = await walked.open(reached.source, reached.storage);
      } catch (error) {
        for (const { tenant } of owned) refused.push({ tenant, namedBy, error });
        continue;
      }
      for (const each of owned) {
        const { tenant, resolved, named } = each;
        try {
          const done = await removeCopy(
            store,
            async () => (named === null ? null : walked.open(named, resolved.storage)),
            { tenant, namedBy },
            despiteLostKeys,
          );
          if (done !== null) removed.push(done);
        } catch (error) {
          refused.push({ tenant, namedBy, error });
        }
      }
    }
  } finally {
    await walked.close();
  }
  return { removed: byTenant(removed), refused: byTenant(refused), unreached: walked.unreached };
};

/**
 * What `bounda.config.ts` exports as a whole, and its `tenants` export, as `boot` hands them to
 * `createApp`.
 */
export interface AppProject {
  readonly config: ProjectConfig;
  readonly tenants?: ProjectTenants;
}

export interface RemoveKeyCopiesOfArgs {
  readonly project: AppProject;
  readonly env: AppEnv;
  readonly tenant: string;
}

export interface RemoveKeyCopiesOfFunction {
  (args: RemoveKeyCopiesOfArgs): Promise<RemovedStaleTenantKeys>;
}

// What a forgetting runs once the named store holds it: never rejects, since the tenant is
// forgotten whatever it leaves, and what it could not reach is `unreached` under the tenant.
export const removeKeyCopiesOf: RemoveKeyCopiesOfFunction = async ({ project, env, tenant }) => {
  try {
    const { config, tenants = [] } = project;
    return await removeStaleTenantKeys({
      config,
      env,
      tenant,
      tenants: typeof tenants === "function" ? await tenants() : tenants,
      only: [tenant],
    });
  } catch (error) {
    return { removed: [], refused: [], unreached: [{ tenant, error }] };
  }
};
