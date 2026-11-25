import { ConfigurationError } from "@bounda-dev/core";
import { type AdapterDefinition, checkPlacement } from "@bounda-dev/core/adapter";
import type { Config } from "@bounda-dev/core/config";
import { isJurisdiction, JURISDICTIONS_LISTED } from "./jurisdiction.ts";
import { isKeptInKv } from "./kv-placement.ts";

/**
 * Options of the Cloudflare adapter.
 */
export interface CloudflareOptions {
  /**
   * Put in front of every table Bounda creates in the Durable Object's SQLite. Defaults to
   * `bounda_`.
   */
  readonly tablePrefix?: string;
  /**
   * The name of the Bounda Durable Object's binding in `wrangler.jsonc`, through which the Worker
   * reaches the app. Defaults to `"STORE"`.
   */
  readonly binding?: string;
  /**
   * The jurisdiction every tenant's Durable Object is created in and never leaves: `"eu"` to keep
   * the data in the European Union, `"us"`, `"fedramp"` or `"fedramp-high"` in the United States.
   * `createWorker`, the React Router hosts and `tenantStub` reach the objects through it, and an
   * object reached through any other refuses to start. Choose it before the first object exists:
   * an object never moves, and a tenant reached in a new jurisdiction is a new, empty object. Left
   * out, each object is placed near the request that created it. Ignored where workerd runs locally (`wrangler dev`, `vite dev`, the tests),
   * which has no jurisdictions. It is the app's `location`: every read model, the tenant key
   * store, the forget ledger and the key wrapper must be kept under its legal regime too, as
   * `durableObjectTenantKeys` and `durableObjectForgetLedger` are, or under another with a
   * `safeguard`; a read model on another adapter, and `masterKey` or `defineKeyWrapper`, declare
   * it, or another location under the same regime, as their `location`.
   */
  readonly jurisdiction?: DurableObjectJurisdiction;
}

/**
 * What `cloudflare()` returns and `bounda.config.ts` holds under `storage`. It carries no
 * connection: the storage exists only inside a Durable Object, and `createBoundaObject` builds the
 * adapter from it there.
 */
export type CloudflareDefinition = AdapterDefinition<
  "cloudflare",
  CloudflareOptions & { readonly binding: string }
>;

export interface CloudflareFunction {
  (options?: CloudflareOptions): CloudflareDefinition;
}

/**
 * Storage in the SQLite of the Durable Object the app runs in: events, ledgers and read models,
 * all in one object, whose `location` is the `jurisdiction`. Throws `ConfigurationError` for a
 * `jurisdiction` that is none of Cloudflare's; a configuration that puts it beside another
 * storage, a read model on it in another jurisdiction than `storage`, or, with a `jurisdiction`,
 * a read model, tenant key store, forget ledger or key wrapper kept under another legal regime, as
 * a Workers KV one always is, without a `safeguard` that allows it, is refused wherever it is
 * resolved, the record of processing included.
 */
export const cloudflare: CloudflareFunction = ({ binding = "STORE", ...options } = {}) => {
  // A Worker's code is not always type-checked.
  const jurisdiction: unknown = options.jurisdiction;
  if (jurisdiction !== undefined && !isJurisdiction(jurisdiction)) {
    throw new ConfigurationError(
      `cloudflare({ jurisdiction }) names a Durable Object jurisdiction, one of ${JURISDICTIONS_LISTED}, not ${JSON.stringify(jurisdiction)}`,
    );
  }
  return {
    kind: "bounda-adapter",
    name: "cloudflare",
    options: { ...options, binding },
    ...(jurisdiction === undefined ? {} : { location: jurisdiction }),
    check: (config) => void cloudflareStorageOf(config),
  };
};

export interface IsCloudflareDefinitionFunction {
  (value: unknown): value is CloudflareDefinition;
}

/**
 * Whether a configuration's `storage`, or one of its `readModels`, is `cloudflare()`: what tells
 * that the app runs in a Durable Object.
 */
export const isCloudflareDefinition: IsCloudflareDefinitionFunction = (
  value,
): value is CloudflareDefinition =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "bounda-adapter" &&
  Reflect.get(value, "name") === "cloudflare";

export interface CloudflareStorageOfFunction {
  (config: Config): CloudflareDefinition;
}

export const cloudflareStorageOf: CloudflareStorageOfFunction = (config) => {
  // A Worker's code is not always type-checked.
  const storage = (config as Partial<Config> | undefined)?.storage;
  if (!isCloudflareDefinition(storage)) {
    throw new ConfigurationError(
      `A Bounda app on Cloudflare stores its events in its Durable Object's SQLite: set storage to cloudflare(), not ${JSON.stringify(storage?.name)}`,
    );
  }
  const { jurisdiction } = storage.options;
  // A read model on cloudflare() lives in the tenant's object, wherever that is: one naming
  // another jurisdiction would tell the record of processing a place its data is not.
  for (const [name, definition] of Object.entries(config.readModels ?? {})) {
    if (isCloudflareDefinition(definition) && definition.options.jurisdiction !== jurisdiction) {
      throw new ConfigurationError(
        `The read model ${name} lives in the tenant's Durable Object, in the jurisdiction storage names: give its cloudflare() ${jurisdiction === undefined ? "no jurisdiction" : `jurisdiction: ${JSON.stringify(jurisdiction)}`} too`,
      );
    }
  }
  if (jurisdiction !== undefined) {
    const personalData: unknown = (config as Partial<Config>).runtime?.personalData;
    checkKeptIn({
      where: jurisdiction,
      path: "runtime.personalData.tenantKeys",
      source: valueAt(personalData, "tenantKeys"),
      keeper: "durableObjectTenantKeys",
      define: "defineTenantKeyStore",
    });
    checkKeptIn({
      where: jurisdiction,
      path: "runtime.personalData.forgetLedger.store",
      source: valueAt(valueAt(personalData, "forgetLedger"), "store"),
      keeper: "durableObjectForgetLedger",
      define: "defineForgetLedger",
    });
  }
  return storage;
};

const valueAt = (holder: unknown, key: string): unknown =>
  typeof holder === "object" && holder !== null ? Reflect.get(holder, key) : undefined;

interface CheckKeptInArgs {
  readonly where: DurableObjectJurisdiction;
  readonly path: string;
  readonly source: unknown;
  readonly keeper: string;
  readonly define: string;
}

// The tenant key store and the forget ledger hold wrapped keys and the ids of persons: kept under
// another legal regime than the tenants' objects, they would be transferred out of it, which only a
// safeguard allows. Checked here as well as by `checkLocations`, since the Worker and the keeper
// start without resolving the configuration.
const checkKeptIn = ({ where, path, source, keeper, define }: CheckKeptInArgs): void => {
  if (source === undefined) return;
  checkPlacement({
    path,
    holder: Object(source),
    where,
    fix: (home) =>
      isKeptInKv(source)
        ? `use ${keeper}({ storage }), which keeps it in jurisdiction ${JSON.stringify(home)}, or, as Workers KV holds what it keeps to no jurisdiction, declare location: "global" with the safeguard that allows that`
        : `use ${keeper}({ storage }), which keeps it in the same jurisdiction, ${keeper}({ storage, jurisdiction, safeguard }) to keep it in another under a safeguard, or a store of your own that names where it keeps it, through ${define}(create, { location: ${JSON.stringify(home)} })`,
  });
};
