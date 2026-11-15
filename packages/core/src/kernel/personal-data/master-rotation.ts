import type {
  StoredFileKey,
  StoredTenantKey,
  TenantKeyStore,
  VersionedTenantKeyRecord,
} from "../../adapter/storage/tenant-key-store.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { fromBase64, tenantFingerprintOf, toBase64 } from "./crypto.ts";
import { buildKeyWrapper, type CryptoKeyWrapper } from "./key-wrapper.ts";
import { openTenantKeyStore } from "./tenant-key-source.ts";

// How many tenants a page of the store lists.
const PAGE = 500;

// How many times a rewrap that lost the race to another writer reads the record again.
const PUT_ATTEMPTS = 5;

const underPrevious = (
  record: VersionedTenantKeyRecord,
  master: Pick<CryptoKeyWrapper, "kid">,
): boolean =>
  record.forgotten === null
    ? record.keys.some(({ wrappedBy }) => wrappedBy !== master.kid)
    : (record.forgotten.files ?? []).some(({ wrappedBy }) => wrappedBy !== master.kid);

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

export interface RewrapTenantKeysArgs {
  /**
   * The project's configuration: its `runtime.personalData.keyWrapper` and `tenantKeys`.
   */
  readonly config: Config;
  /**
   * The environment the key wrapper and the store read, such as `process.env`.
   */
  readonly env: AppEnv;
}

export interface RewrappedTenantKeys {
  /**
   * The tenants a version of whose key it rewrapped.
   */
  readonly rewrapped: readonly string[];
  /**
   * The tenants still under a previous master key, which it could not rewrap: until none is
   * left, the previous master keys must stay.
   */
  readonly left: readonly { readonly tenant: string; readonly error: unknown }[];
}

export interface RewrapTenantKeysFunction {
  (args: RewrapTenantKeysArgs): Promise<RewrappedTenantKeys>;
}

// The master key and the tenant key store the configuration names, both built from `env`.
const opened = async ({ config, env }: RewrapTenantKeysArgs) => {
  const resolved = resolveConfig(config);
  const { keyWrapper, tenantKeys } = resolved.runtime.personalData;
  if (keyWrapper === null || tenantKeys === null) {
    throw runtimeText(
      new ConfigurationError(
        "Rewrapping the tenants' keys needs runtime.personalData.keyWrapper and runtime.personalData.tenantKeys",
      ),
    );
  }
  const master = await buildKeyWrapper({ definition: keyWrapper, env });
  const store = await openTenantKeyStore({ source: tenantKeys, storage: resolved.storage, env });
  return { master, store };
};

export interface ListTenantsUnderPreviousMasterFunction {
  (args: RewrapTenantKeysArgs): Promise<readonly string[]>;
}

/**
 * The tenants, not forgotten, a version of whose key the tenant key store holds under another
 * master key than the configuration's in force: what a rotation of the master key has left to
 * rewrap, and what must be none before the previous master keys go.
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

/**
 * Rewraps under the master key in force the key of every tenant the tenant key store holds, the
 * tenants' apps running or not: the one write a rotation of the master key needs. What
 * `bounda tenant-key rewrap-master` runs. The store must compare and set, as a SQL table does;
 * on Cloudflare each tenant's object rewraps its own, woken by `createWorker`'s `scheduled`.
 */
export const rewrapTenantKeys: RewrapTenantKeysFunction = async (args) => {
  const { master, store } = await opened(args);
  try {
    if (store.oneWriterPerTenant === true) {
      throw runtimeText(
        new ConfigurationError(
          "The tenant key store is written by each tenant's own writer alone, as KV is: rewrap each tenant there, as createWorker's scheduled does on Cloudflare",
        ),
      );
    }
    const done: string[] = [];
    const left: { tenant: string; error: unknown }[] = [];
    for (const tenant of await tenantsUnderPreviousMaster({ store, master })) {
      try {
        if ((await rewrapRecordUnderMaster({ store, master, tenant })) > 0) done.push(tenant);
      } catch (error) {
        left.push({ tenant, error });
      }
    }
    return { rewrapped: done, left };
  } finally {
    await store.close?.();
  }
};
