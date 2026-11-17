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
