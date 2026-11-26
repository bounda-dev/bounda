import { byCodeUnit } from "../../adapter/storage/forget-ledger.ts";
import type {
  StoredFileKey,
  StoredTenantKey,
  TenantKeyStore,
  VersionedTenantKeyRecord,
} from "../../adapter/storage/tenant-key-store.ts";
import { configForTenant } from "../../config/define-config.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config, ProjectConfig } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { tenantIdOf } from "../tenant.ts";
import { fromBase64, tenantFingerprintOf, toBase64 } from "./crypto.ts";
import {
  buildKeyWrapper,
  type CryptoKeyWrapper,
  type KeyWrapperDefinition,
} from "./key-wrapper.ts";
import { openTenantKeyStore } from "./tenant-key-source.ts";
import { reachTenants, type UnreachedTenant } from "./tenant-reach.ts";

// How many tenants a page of the store lists.
const PAGE = 500;

// How many times a rewrap that lost the race to another writer reads the record again.
const PUT_ATTEMPTS = 5;

// The master keys a version of the tenant's key, or, once forgotten, a key of its files kept until
// its recipients are told, is wrapped under.
const wrappingMasters = (record: VersionedTenantKeyRecord): readonly string[] =>
  (record.forgotten === null ? record.keys : (record.forgotten.files ?? [])).map(
    ({ wrappedBy }) => wrappedBy,
  );

const underPrevious = (
  record: VersionedTenantKeyRecord,
  master: Pick<CryptoKeyWrapper, "kid">,
): boolean => wrappingMasters(record).some((wrappedBy) => wrappedBy !== master.kid);

export interface TenantsUnderPreviousMasterArgs {
  readonly store: TenantKeyStore;
  readonly master: Pick<CryptoKeyWrapper, "kid">;
}

export interface TenantsUnderPreviousMasterFunction {
  (args: TenantsUnderPreviousMasterArgs): Promise<readonly string[]>;
}

/**
 * The tenants a version of whose key, or, once forgotten, a key of whose files kept until its
 * recipients are told, is wrapped under another master key than the one in force, in order.
 */
export const tenantsUnderPreviousMaster: TenantsUnderPreviousMasterFunction = async ({
  store,
  master,
}) => {
  const found: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await store.list({ cursor, limit: PAGE });
    for (const tenant of page.tenants) {
      const record = await store.get(tenant);
      if (record !== null && underPrevious(record, master)) found.push(tenant);
    }
    cursor = page.cursor;
  } while (cursor !== null);
  return found;
};

export interface RewrapRecordArgs {
  readonly store: TenantKeyStore;
  readonly master: CryptoKeyWrapper;
  readonly tenant: string;
}

export interface RewrapRecordFunction {
  (args: RewrapRecordArgs): Promise<number>;
}

const rewrapped = async (
  tenant: string,
  stored: StoredTenantKey,
  master: CryptoKeyWrapper,
): Promise<StoredTenantKey> => {
  knownMaster(tenant, stored.wrappedBy, master);
  const exportable = await master.unwrap({
    kid: stored.wrappedBy,
    wrapped: fromBase64(stored.key),
    extractable: true,
    kind: "tenant",
  });
  if ((await tenantFingerprintOf(exportable)) !== stored.fingerprint) {
    throw runtimeText(
      new ConfigurationError(
        `Tenant ${tenant}'s key unwrapped under ${stored.wrappedBy} does not match its fingerprint: the key wrapper returned another key`,
      ),
    );
  }
  const { wrapped } = await master.wrap(exportable);
  return { ...stored, key: toBase64(wrapped), wrappedBy: master.kid };
};

const knownMaster = (tenant: string, wrappedBy: string, master: CryptoKeyWrapper): void => {
  if (wrappedBy !== master.kid && !master.previous.includes(wrappedBy)) {
    throw runtimeText(
      new ConfigurationError(
        `Tenant ${tenant}'s key is wrapped under the master key ${wrappedBy}, which is neither the key wrapper's key nor one of its previous ones`,
      ),
    );
  }
};

// A key of a forgotten tenant's file, kept under the master key until its recipients are told.
const rewrappedFile = async (
  tenant: string,
  stored: StoredFileKey,
  master: CryptoKeyWrapper,
): Promise<StoredFileKey> => {
  knownMaster(tenant, stored.wrappedBy, master);
  const exportable = await master.unwrap({
    kid: stored.wrappedBy,
    wrapped: fromBase64(stored.key),
    extractable: true,
    kind: "personal",
  });
  const { wrapped } = await master.wrap(exportable);
  return { ...stored, key: toBase64(wrapped), wrappedBy: master.kid };
};

/**
 * Rewraps under the master key in force every version of the tenant's key wrapped under a previous
 * one, and every key of a forgotten tenant's files, over the revision read, reading it again when
 * another writer came first. Resolves to how many keys it rewrapped.
 */
export const rewrapRecordUnderMaster: RewrapRecordFunction = async ({ store, master, tenant }) => {
  for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt += 1) {
    const record = await store.get(tenant);
    if (record === null || !underPrevious(record, master)) return 0;
    let count = 0;
    if (record.forgotten !== null) {
      const files: StoredFileKey[] = [];
      for (const stored of record.forgotten.files ?? []) {
        if (stored.wrappedBy === master.kid) {
          files.push(stored);
        } else {
          files.push(await rewrappedFile(tenant, stored, master));
          count += 1;
        }
      }
      const { revision: _, ...current } = record;
      const next = { ...current, forgotten: { ...record.forgotten, files } };
      if (await store.put(tenant, next, record.revision)) return count;
      continue;
    }
    const keys: StoredTenantKey[] = [];
    for (const stored of record.keys) {
      if (stored.wrappedBy === master.kid) {
        keys.push(stored);
      } else {
        keys.push(await rewrapped(tenant, stored, master));
        count += 1;
      }
    }
    const { revision: _, ...current } = record;
    if (await store.put(tenant, { ...current, keys }, record.revision)) return count;
  }
  throw runtimeText(
    new ConfigurationError(
      `The record of tenant ${tenant}'s key kept changing while it was rewrapped`,
    ),
  );
};

export interface ListTenantsUnderPreviousMasterArgs {
  /**
   * The configuration of one tenant: its `runtime.personalData.keyWrapper` and `tenantKeys`.
   */
  readonly config: Config;
  /**
   * The environment the key wrapper and the store read, such as `process.env`.
   */
  readonly env: AppEnv;
}

export interface ListTenantsUnderPreviousMasterFunction {
  (args: ListTenantsUnderPreviousMasterArgs): Promise<readonly string[]>;
}

const NEEDS_KEYS =
  "Rewrapping the tenants' keys needs runtime.personalData.keyWrapper and runtime.personalData.tenantKeys";

// The master key and the tenant key store the configuration names, both built from `env`.
const opened = async ({ config, env }: ListTenantsUnderPreviousMasterArgs) => {
  const resolved = resolveConfig(config);
  const { keyWrapper, tenantKeys } = resolved.runtime.personalData;
  if (keyWrapper === null || tenantKeys === null) {
    throw runtimeText(new ConfigurationError(NEEDS_KEYS));
  }
  const master = await buildKeyWrapper({ definition: keyWrapper, env });
  const store = await openTenantKeyStore({ source: tenantKeys, storage: resolved.storage, env });
  return { master, store };
};

/**
 * The tenants, not forgotten, a version of whose key the tenant key store the configuration names
 * holds under another master key than the configuration's in force: what a rotation of the master
 * key has left to rewrap there, and what must be none before the previous master keys go. It reads
 * that one store: `rewrapTenantKeys` reaches every store a configuration that is a function of the
 * tenant names.
 */
export const listTenantsUnderPreviousMaster: ListTenantsUnderPreviousMasterFunction = async (
  args,
) => {
  const { master, store } = await opened(args);
  try {
    return await tenantsUnderPreviousMaster({ store, master });
  } finally {
    await store.close?.();
  }
};

export interface RewrapTenantKeysArgs {
  /**
   * What `bounda.config.ts` exports, as `loadProject` gives it in `projectConfig`: one
   * configuration, or a function of the tenant, called for every tenant reached. Each tenant's key
   * is rewrapped under the `runtime.personalData.keyWrapper` of its own configuration.
   */
  readonly config: ProjectConfig;
  /**
   * The environment the key wrappers and the stores read, such as `process.env`.
   */
  readonly env: AppEnv;
  /**
   * The tenant to start from, whose configuration must name a key wrapper and a tenant key store.
   * Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
  /**
   * Tenants to reach beside those the stores list, as the `tenants` export of `bounda.config.ts`
   * names them, `loadProject`'s `tenants()`.
   */
  readonly tenants?: readonly string[];
}

export interface RewrappedTenantKeys {
  /**
   * The tenants a version of whose key it rewrapped, in code-unit order.
   */
  readonly rewrapped: readonly string[];
  /**
   * The tenants whose key, in a store the configuration names, it could not rewrap or read, in
   * code-unit order: until none is left, the previous master keys must stay.
   */
  readonly left: readonly { readonly tenant: string; readonly error: unknown }[];
  /**
   * The tenants reached whose configuration or stores could not be read: a store only they name
   * may hold keys under a previous master key, so until none is left, those keys must stay too.
   */
  readonly unreached: readonly UnreachedTenant[];
}

export interface RewrapTenantKeysFunction {
  (args: RewrapTenantKeysArgs): Promise<RewrappedTenantKeys>;
}

const ONE_WRITER =
  "The tenant key store is written by each tenant's own writer alone, as KV is: rewrap each tenant there, as createWorker's scheduled does on Cloudflare";

// The master key in force for each key wrapper definition, built once.
const mastersIn = (env: AppEnv) => {
  const built = new Map<KeyWrapperDefinition, Promise<CryptoKeyWrapper>>();
  return (definition: KeyWrapperDefinition): Promise<CryptoKeyWrapper> => {
    const known = built.get(definition);
    if (known !== undefined) return known;
    const building = buildKeyWrapper({ definition, env });
    built.set(definition, building);
    return building;
  };
};

// Rewraps the tenant's record in the store under its own configuration's master key; resolves to
// whether it rewrapped a key.
const rewrapIn = async (
  store: TenantKeyStore,
  tenant: string,
  definition: KeyWrapperDefinition | null,
  masterOf: (definition: KeyWrapperDefinition) => Promise<CryptoKeyWrapper>,
): Promise<boolean> => {
  if (definition === null) {
    const record = await store.get(tenant);
    if (record === null || wrappingMasters(record).length === 0) return false;
    throw runtimeText(
      new ConfigurationError(
        `Tenant ${tenant}'s key is wrapped under a master key, and its configuration names no runtime.personalData.keyWrapper to rewrap it under`,
      ),
    );
  }
  const master = await masterOf(definition);
  if (store.oneWriterPerTenant === true) {
    const record = await store.get(tenant);
    if (record !== null && underPrevious(record, master)) {
      throw runtimeText(new ConfigurationError(ONE_WRITER));
    }
    return false;
  }
  return (await rewrapRecordUnderMaster({ store, master, tenant })) > 0;
};

/**
 * Rewraps under the master key in force the key of every tenant every tenant key store the
 * configuration can name holds, the tenants' apps running or not: the one write a rotation of the
 * master key needs. What `bounda tenant-key rewrap-master` runs. It starts from `tenant` and those
 * `tenants` names, and reaches every tenant the tenant key store and the forget ledger's store of
 * each reached tenant's configuration list, as `listForgetLedgerTenants` does, reading each store
 * once; each key is rewrapped under the key wrapper of its tenant's own configuration. A store must
 * compare and set, as a SQL table does; on Cloudflare each tenant's object rewraps its own, woken
 * by `createWorker`'s `scheduled`. Rejects with `ConfigurationError` when the starting tenant's
 * configuration names no key wrapper or tenant key store, or one written by each tenant's own
 * writer alone, as KV is, and when its stores cannot be listed; any other failure is in `left` or
 * `unreached`.
 */
export const rewrapTenantKeys: RewrapTenantKeysFunction = async ({
  config,
  env,
  tenant: named,
  tenants = [],
}) => {
  const first = tenantIdOf(named);
  const firstConfig = configForTenant({ config, tenant: first });
  const { keyWrapper, tenantKeys } = resolveConfig(firstConfig).runtime.personalData;
  if (keyWrapper === null || tenantKeys === null) {
    throw runtimeText(new ConfigurationError(NEEDS_KEYS));
  }
  const masterOf = mastersIn(env);
  await masterOf(keyWrapper);
  const { configs, keyStores, unreached } = await reachTenants({
    config,
    env,
    first,
    firstConfig,
    tenants,
    // Only the tenants it lists matter here, as each definition's first ledger lists them.
    physical: false,
    // A ledger that cannot list its tenants only adds none to reach.
    listLedger: async (ledger) => (await ledger.tenants?.()) ?? [],
  });
  const done = new Set<string>();
  const left = new Map<string, unknown>();
  const leave = (tenant: string, error: unknown): void => {
    if (!left.has(tenant)) left.set(tenant, error);
  };
  for (const [index, { source, storage, tenants: listed }] of keyStores.entries()) {
    // Those whose configuration could not be resolved are in `unreached` already.
    const owned = listed.flatMap((tenant) => {
      const resolved = configs.get(tenant);
      return resolved === undefined
        ? []
        : [{ tenant, keyWrapper: resolved.runtime.personalData.keyWrapper }];
    });
    let store: TenantKeyStore;
    try {
      store = await openTenantKeyStore({ source, storage, env });
    } catch (error) {
      for (const { tenant } of owned) leave(tenant, error);
      continue;
    }
    try {
      // The starting tenant's store is the first read.
      if (index === 0 && store.oneWriterPerTenant === true) {
        throw runtimeText(new ConfigurationError(ONE_WRITER));
      }
      for (const { tenant, keyWrapper: definition } of owned) {
        try {
          if (await rewrapIn(store, tenant, definition, masterOf)) done.add(tenant);
        } catch (error) {
          leave(tenant, error);
        }
      }
    } finally {
      await store.close?.();
    }
  }
  return {
    rewrapped: [...done].sort(byCodeUnit),
    left: [...left]
      .map(([tenant, error]) => ({ tenant, error }))
      .sort((a, b) => byCodeUnit(a.tenant, b.tenant)),
    unreached,
  };
};
