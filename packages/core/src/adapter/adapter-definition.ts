/**
 * What an adapter factory such as `sqlite({ path })` returns and what `bounda.config.ts` holds
 * under `storage` and `readModels`. It carries the adapter name and its options; the port
 * factories the kernel needs are added by the adapter SPI.
 */
export interface AdapterDefinition<Name extends string = string, Options = unknown> {
  readonly kind: "bounda-adapter";
  readonly name: Name;
  readonly options: Options;
}

export interface IsAdapterDefinitionFunction {
  (value: unknown): value is AdapterDefinition;
}

/**
 * Runtime check used when validating the configuration.
 */
export const isAdapterDefinition: IsAdapterDefinitionFunction = (
  value,
): value is AdapterDefinition =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "bounda-adapter" &&
  typeof Reflect.get(value, "name") === "string";
