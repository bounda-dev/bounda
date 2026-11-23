import type { Config } from "../config/types.ts";

/**
 * What `bounda.config.ts` holds under `storage` and `readModels`: an adapter's name and options.
 * An adapter factory such as `sqlite({ path })` returns the full `Adapter`, which adds the store
 * factories.
 */
export interface AdapterDefinition<Name extends string = string, Options = unknown> {
  readonly kind: "bounda-adapter";
  readonly name: Name;
  readonly options: Options;
  /**
   * Where the database keeps its data, as its `location` option, or `cloudflare({ jurisdiction })`,
   * declares it, such as `"eu"`. The record of processing (`personalDataInventory`) states it next
   * to every holder and record kept there, and under a storage that declares one, every other
   * store must declare the same.
   */
  readonly location?: string;
  /**
   * Refuses, with `ConfigurationError`, a configuration this adapter cannot serve, such as a read
   * model kept apart from where the adapter says the data lives. Run every time a configuration
   * is resolved, for `storage` and each of `readModels`: an app refuses to start on it, and so does
   * the record of processing (`personalDataInventory`).
   */
  readonly check?: (config: Config) => void;
}

/**
 * The `location` option every adapter takes: where its database keeps the data.
 */
export interface DataLocationOptions {
  /**
   * The jurisdiction the database keeps its data in, such as `"eu"`, written the same way for
   * every store of the app; you answer for it, as Bounda cannot see where a database runs. The
   * record of processing states it next to everything kept there, and lists each store that
   * declares none as a finding. Declared on `storage`, it is the app's: the app refuses to start
   * on a read model, tenant key store or forget ledger that declares another, or none.
   */
  readonly location?: string;
}

export interface IsAdapterDefinitionFunction {
  (value: unknown): value is AdapterDefinition;
}

export const isAdapterDefinition: IsAdapterDefinitionFunction = (
  value,
): value is AdapterDefinition =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "bounda-adapter" &&
  typeof Reflect.get(value, "name") === "string";
