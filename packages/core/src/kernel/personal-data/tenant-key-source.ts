import type { Adapter } from "../../adapter/adapter.ts";
import type { AdapterDefinition } from "../../adapter/adapter-definition.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import { sharesStorage } from "./forget-ledger.ts";

export interface CreateTenantKeyStoreArgs {
  /**
   * The host's environment, as port implementations receive it: `process.env` in Node, the
   * Worker's bindings in a Durable Object.
   */
  readonly env: AppEnv;
}

/**
 * A tenant key store built from the host's environment when the app starts, by
 * `defineTenantKeyStore` or a host package, such as `kvTenantKeys` from `@bounda-dev/cloudflare`.
 */
export interface TenantKeyStoreDefinition {
  readonly kind: "bounda-tenant-key-store";
  create(args: CreateTenantKeyStoreArgs): TenantKeyStore | Promise<TenantKeyStore>;
  /**
   * Where the store keeps the keys, when it pins it, as an adapter's `location` does, such as
   * `"jurisdiction eu"`.
   */
  readonly location?: string;
}

/**
 * Options of `defineTenantKeyStore` and `defineForgetLedger`.
 */
export interface StoreDefinitionOptions {
  /**
   * Where the store keeps what it holds, when it pins it, written as an adapter's `location` is,
   * such as `"jurisdiction eu"`: the record of processing states it, and an app on Cloudflare
   * whose `cloudflare({ jurisdiction })` names one refuses a store that does not name the same.
   */
  readonly location?: string;
}

/**
 * What `runtime.personalData.tenantKeys` holds: an adapter pointed at another database than the
 * storage, whose table it creates there, or a tenant key store definition.
 */
export type TenantKeySource = Adapter | TenantKeyStoreDefinition;

export interface DefineTenantKeyStoreFunction {
  (
    create: TenantKeyStoreDefinition["create"],
    options?: StoreDefinitionOptions,
  ): TenantKeyStoreDefinition;
}

/**
 * A tenant key store of your own, built from the host's environment when the app starts. A
 * `create` that throws fails the start. The store must live apart from every tenant's database,
 * list its tenants in pages, and its `put` must compare the revision and set the record at once,
 * unless one writer alone writes each tenant's record, when it says `oneWriterPerTenant: true`.
 */
export const defineTenantKeyStore: DefineTenantKeyStoreFunction = (create, { location } = {}) => ({
  kind: "bounda-tenant-key-store",
  create,
  ...(location === undefined ? {} : { location }),
});

export interface IsTenantKeySourceFunction {
  (value: unknown): value is TenantKeySource;
}

export const isTenantKeySource: IsTenantKeySourceFunction = (value): value is TenantKeySource => {
  if (typeof value !== "object" || value === null) return false;
  const kind = Reflect.get(value, "kind");
  if (kind === "bounda-tenant-key-store") return typeof Reflect.get(value, "create") === "function";
  return (
    kind === "bounda-adapter" && typeof Reflect.get(value, "createTenantKeyStore") === "function"
  );
};

export interface OpenTenantKeyStoreArgs extends CreateTenantKeyStoreArgs {
  readonly source: TenantKeySource;
  readonly storage: AdapterDefinition;
}

export interface OpenTenantKeyStoreFunction {
  (args: OpenTenantKeyStoreArgs): Promise<TenantKeyStore>;
}

/**
 * Refuses an adapter that points at the storage's own database: a copy or a restore of it would
 * hold the tenant's key too.
 */
export const openTenantKeyStore: OpenTenantKeyStoreFunction = async ({ source, storage, env }) => {
  if (source.kind === "bounda-adapter" && sharesStorage(source, storage)) {
    throw new ConfigurationError(
      "runtime.personalData.tenantKeys points at the storage's own database, which every copy and restore of it carries: give it another database",
    );
  }
  return source.kind === "bounda-tenant-key-store"
    ? source.create({ env })
    : source.createTenantKeyStore();
};
