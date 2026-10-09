import type { AdapterDefinition } from "@bounda-dev/core/adapter";

/**
 * Options of the Cloudflare adapter.
 */
export interface CloudflareOptions {
  /**
   * Put in front of every table Bounda creates in the Durable Object's SQLite. Defaults to
   * `bounda_`.
   */
  readonly tablePrefix?: string;
}

/**
 * What `cloudflare()` returns and `bounda.config.ts` holds under `storage`. It carries no
 * connection: the storage exists only inside a Durable Object, and `createBoundaObject` builds the
 * adapter from it there.
 */
export type CloudflareDefinition = AdapterDefinition<"cloudflare", CloudflareOptions>;

export interface CloudflareFunction {
  (options?: CloudflareOptions): CloudflareDefinition;
}

/**
 * Storage in the SQLite of the Durable Object the app runs in: events, ledgers and read models,
 * all in one object.
 */
export const cloudflare: CloudflareFunction = (options = {}) => ({
  kind: "bounda-adapter",
  name: "cloudflare",
  options,
});

export interface IsCloudflareDefinitionFunction {
  (value: unknown): value is CloudflareDefinition;
}

/**
 * Whether a configured adapter is `cloudflare()`.
 */
export const isCloudflareDefinition: IsCloudflareDefinitionFunction = (
  value,
): value is CloudflareDefinition =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "bounda-adapter" &&
  Reflect.get(value, "name") === "cloudflare";

/**
 * The table prefix `cloudflare()` uses when none is given.
 */
export const DEFAULT_TABLE_PREFIX: string = "bounda_";
