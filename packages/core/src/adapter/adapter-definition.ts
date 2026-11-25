import type { Config } from "../config/types.ts";
import type { StoreSafeguard } from "../modules/recipient.ts";

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
   * store must declare the same, or another with a `safeguard`.
   */
  readonly location?: string;
  /**
   * What allows a read model's database to keep its data in another `location` than `storage`'s,
   * as its `safeguard` option declares it.
   */
  readonly safeguard?: StoreSafeguard;
  /**
   * Refuses, with `ConfigurationError`, a configuration this adapter cannot serve, such as a read
   * model kept apart from where the adapter says the data lives. Run every time a configuration
   * is resolved, for `storage` and each of `readModels`: an app refuses to start on it, and so does
   * the record of processing (`personalDataInventory`).
   */
  readonly check?: (config: Config) => void;
}

/**
 * The `location` and `safeguard` options every adapter, `masterKey`, `defineKeyWrapper`,
 * `defineTenantKeyStore` and `defineForgetLedger` take: where the data, or the key, is kept, and
 * what allows keeping it there when that is not where `storage` keeps the app's.
 */
export type DataLocationOptions =
  | {
      /**
       * The jurisdiction it is kept in, such as `"eu"`, written the same way across the app; you
       * answer for it, as Bounda cannot see where a database or a host runs. The record of
       * processing states it next to everything kept there, and lists each store that declares
       * none as a finding. Declared on `storage`, it is the app's: the app refuses to start on a
       * read model, tenant key store, forget ledger or key wrapper that declares none, or another
       * without a `safeguard`.
       */
      readonly location?: string;
      readonly safeguard?: never;
    }
  | {
      readonly location: string;
      /**
       * What allows keeping it in `location`, another jurisdiction than `storage`'s, under
       * articles 45 to 47 of the GDPR. The record of processing and each person's export tell of
       * the transfer and its safeguard. The app refuses to start on one declared where `storage`
       * keeps the app's data, which is no transfer, on `storage` itself, or under a `storage` that
       * declares no location.
       */
      readonly safeguard: StoreSafeguard;
    };

/**
 * Where an adapter's or a store's definition says it keeps its data, and the safeguard that allows
 * keeping it there, as `AdapterDefinition` carries them.
 */
export interface Placement {
  readonly location?: string;
  readonly safeguard?: StoreSafeguard;
}

/**
 * `placementOf`'s signature.
 */
export interface PlacementOfFunction {
  (options: {
    readonly location?: string | undefined;
    readonly safeguard?: StoreSafeguard | undefined;
  }): Placement;
}

/**
 * The `location` and `safeguard` of an adapter's or a store's options, as its definition carries
 * them, each left out when not declared: what an adapter of your own spreads into what it returns.
 */
export const placementOf: PlacementOfFunction = ({ location, safeguard }) => ({
  ...(location === undefined ? {} : { location }),
  ...(safeguard === undefined ? {} : { safeguard }),
});

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
