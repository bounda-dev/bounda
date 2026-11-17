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
   * Where the database keeps its data, when the definition pins it, such as `"jurisdiction eu"`
   * for Durable Objects held in the EU. The record of processing (`personalDataInventory`) states
   * it next to every holder and record kept there.
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
