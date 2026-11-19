import { ConfigurationError } from "@bounda-dev/core";
import type { AdapterDefinition } from "@bounda-dev/core/adapter";
import type { Config } from "@bounda-dev/core/config";

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
   * The jurisdiction every tenant's Durable Object is created in and never leaves, such as `"eu"`
   * to keep the data in the European Union. `createWorker`, the React Router hosts and
   * `tenantStub` reach the objects through it, and an object reached through any other refuses to
   * start. Choose it before the first object exists: an object never moves, and a tenant reached
   * in a new jurisdiction is a new, empty object. Left out, each object is placed near the request
   * that created it. Ignored where workerd runs locally (`wrangler dev`, `vite dev`, the tests),
   * which has no jurisdictions. The tenant key store and the forget ledger must be kept in it too:
   * `durableObjectTenantKeys` and `durableObjectForgetLedger` are.
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
 * all in one object. Throws `ConfigurationError` for a `jurisdiction` that is not a name; a
 * configuration that puts it beside another storage, a read model on it in another jurisdiction
 * than `storage`, or, with a `jurisdiction`, a tenant key store or forget ledger whose `location`
 * is not that jurisdiction, as a Workers KV one's never is, is refused wherever it is resolved,
 * the record of processing included.
 */
export const cloudflare: CloudflareFunction = ({ binding = "STORE", ...options } = {}) => {
  // A Worker's code is not always type-checked.
  const jurisdiction: unknown = options.jurisdiction;
  if (jurisdiction !== undefined && (typeof jurisdiction !== "string" || jurisdiction === "")) {
    throw new ConfigurationError(
      `cloudflare({ jurisdiction }) names a Durable Object jurisdiction, such as "eu", not ${JSON.stringify(jurisdiction)}`,
    );
  }
  return {
    kind: "bounda-adapter",
    name: "cloudflare",
    options: { ...options, binding },
    ...(jurisdiction === undefined ? {} : { location: `jurisdiction ${jurisdiction}` }),
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
    const where = `jurisdiction ${jurisdiction}`;
    checkKeptIn({
      where,
      path: "runtime.personalData.tenantKeys",
      source: valueAt(personalData, "tenantKeys"),
      keeper: "durableObjectTenantKeys",
      define: "defineTenantKeyStore",
    });
    checkKeptIn({
      where,
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
  readonly where: string;
  readonly path: string;
  readonly source: unknown;
  readonly keeper: string;
  readonly define: string;
}

// The tenant key store and the forget ledger hold wrapped keys and the ids of persons: kept
// anywhere but the jurisdiction the tenants' objects are in, they would be transferred out of it.
const checkKeptIn = ({ where, path, source, keeper, define }: CheckKeptInArgs): void => {
  if (source === undefined) return;
  const location = valueAt(source, "location");
  if (location === where) return;
  throw new ConfigurationError(
    `${path} keeps what it holds ${typeof location === "string" ? `in ${location}` : "where it names no jurisdiction, as Workers KV does"}, and cloudflare() keeps the tenants' objects in ${where}: use ${keeper}({ storage }), which keeps it in the same jurisdiction, or a store of your own that names it, through ${define}(create, { location: ${JSON.stringify(where)} })`,
  );
};
