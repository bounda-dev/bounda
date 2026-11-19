import { ConfigurationError } from "@bounda-dev/core";
import type { TenantKeyStore } from "@bounda-dev/core/adapter";
import { parseTenantKeyRecord, tenantKeyRecordText } from "@bounda-dev/core/adapter/sql";
import { defineTenantKeyStore, type TenantKeyStoreDefinition } from "@bounda-dev/core/config";

/**
 * What every key of a KV tenant key store starts with: one key per tenant follows.
 */
export const KV_TENANT_KEYS_ROOT = "bounda/tenant-keys/";

interface StoredRecord {
  readonly revision: number;
  readonly record: string;
}

const isStoredRecord = (value: unknown): value is StoredRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "revision") === "number" &&
  typeof Reflect.get(value, "record") === "string";

export interface CreateKvTenantKeyStoreArgs {
  readonly namespace: KVNamespace;
  /**
   * Put in front of every key: what keeps one app's tenants apart from another's in one namespace.
   */
  readonly prefix: string;
}

export interface CreateKvTenantKeyStoreFunction {
  (args: CreateKvTenantKeyStoreArgs): TenantKeyStore;
}

/**
 * One key per tenant, its record and revision as JSON. KV cannot compare and set: `put` reads the
 * revision and writes over it, one write at a time, which holds because one Durable Object, the
 * tenant's own, is the only writer of its tenant's record. The object reads its own writes back,
 * wherever it runs.
 */
export const createKvTenantKeyStore: CreateKvTenantKeyStoreFunction = ({ namespace, prefix }) => {
  const keyOf = (tenant: string): string => `${prefix}${encodeURIComponent(tenant)}`;
  const read = async (tenant: string): Promise<StoredRecord | null> => {
    const stored: unknown = await namespace.get(keyOf(tenant), "json");
    if (stored === null) return null;
    if (!isStoredRecord(stored)) {
      throw new ConfigurationError(`The KV tenant key store holds no record for ${tenant}'s key`);
    }
    return stored;
  };
  // Requests to the object interleave across KV's I/O: one write at a time, so the revision read
  // is still the one written over.
  let writing: Promise<unknown> = Promise.resolve();
  return {
    get: async (tenant) => {
      const stored = await read(tenant);
      return stored === null ? null : parseTenantKeyRecord(stored.record, stored.revision);
    },
    list: async ({ cursor, limit }) => {
      const page = await namespace.list({
        prefix,
        limit,
        ...(cursor === null ? {} : { cursor }),
      });
      return {
        tenants: page.keys.map(({ name }) => decodeURIComponent(name.slice(prefix.length))),
        cursor: page.list_complete ? null : page.cursor,
      };
    },
    oneWriterPerTenant: true,
    put: (tenant, record, expected) => {
      const written = writing.then(async () => {
        if (((await read(tenant))?.revision ?? null) !== expected) return false;
        const stored: StoredRecord = {
          revision: (expected ?? 0) + 1,
          record: tenantKeyRecordText(record),
        };
        await namespace.put(keyOf(tenant), JSON.stringify(stored));
        return true;
      });
      writing = written.catch(() => undefined);
      return written;
    },
  };
};

export interface KvTenantKeysOptions {
  /**
   * The name of the KV namespace's binding in `wrangler.jsonc`.
   */
  readonly binding: string;
  /**
   * Put in front of every tenant's key, so two apps can share a namespace. Defaults to
   * `KV_TENANT_KEYS_ROOT`.
   */
  readonly prefix?: string;
}

export interface KvTenantKeysFunction {
  (options: KvTenantKeysOptions): TenantKeyStoreDefinition;
}

const isKvNamespace = (value: unknown): value is KVNamespace =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "get") === "function" &&
  typeof Reflect.get(value, "put") === "function";

/**
 * A tenant key store in a Workers KV namespace, for `runtime.personalData.tenantKeys` of an app on
 * Cloudflare: outside every Durable Object, so neither restoring an object's storage to an earlier
 * time nor a copy of it brings back the key of a tenant `forgetTenant` destroyed. Each object keeps
 * its tenant's key, wrapped under the master key, under its name, or its id when it has none. A
 * binding missing from the object's `env` fails its start with `ConfigurationError`. KV holds its
 * keys to no jurisdiction, so an app whose `cloudflare()` names one refuses it with
 * `ConfigurationError`: use `durableObjectTenantKeys` there.
 */
export const kvTenantKeys: KvTenantKeysFunction = ({ binding, prefix = KV_TENANT_KEYS_ROOT }) =>
  defineTenantKeyStore(({ env }) => {
    const namespace: unknown = Reflect.get(env, binding);
    if (!isKvNamespace(namespace)) {
      throw new ConfigurationError(
        `runtime.personalData.tenantKeys names the KV binding ${binding}, which the Worker's env does not hold: add it under kv_namespaces in wrangler.jsonc`,
      );
    }
    return createKvTenantKeyStore({ namespace, prefix });
  });
