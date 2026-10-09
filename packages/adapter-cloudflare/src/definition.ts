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
 * all in one object.
 */
export const cloudflare: CloudflareFunction = ({ binding = "STORE", ...options } = {}) => ({
  kind: "bounda-adapter",
  name: "cloudflare",
  options: { ...options, binding },
});

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
  return storage;
};

export const DEFAULT_TABLE_PREFIX: string = "bounda_";
