import { ConfigurationError, type StoreSafeguard } from "@bounda-dev/core";
import { runtimeText } from "@bounda-dev/core/adapter";
import type { StoreDefinitionOptions } from "@bounda-dev/core/config";

/**
 * Where a Workers KV store says it keeps its data, and what allows it: both or neither, as KV
 * holds its keys to no jurisdiction and caches them wherever they are read.
 */
export type KvPlacementOptions =
  | { readonly location?: never; readonly safeguard?: never }
  | {
      /**
       * `"global"`: the namespace keeps and caches what it holds anywhere in the world, never in
       * the jurisdiction `cloudflare()` names alone.
       */
      readonly location: "global";
      /**
       * What allows keeping it there, under articles 46 and 47 of the GDPR, which the record of
       * processing and each person's export tell of: no adequacy decision covers anywhere.
       */
      readonly safeguard: Exclude<StoreSafeguard, "adequacy">;
    };

// The definitions of Workers KV stores, which hold to no jurisdiction even when they name one.
const kvStores = new WeakSet<object>();

export interface KeptInKvFunction {
  <Definition extends object>(definition: Definition): Definition;
}

export const keptInKv: KeptInKvFunction = (definition) => {
  kvStores.add(definition);
  return definition;
};

export interface IsKeptInKvFunction {
  (value: unknown): boolean;
}

export const isKeptInKv: IsKeptInKvFunction = (value) =>
  typeof value === "object" && value !== null && kvStores.has(value);

export interface KvPlacementOfFunction {
  (options: KvPlacementOptions, path: string): StoreDefinitionOptions;
}

// A Worker's code is not always type-checked: the safeguard is passed on for `checkLocations` to
// judge, but any location other than "global", or one without its safeguard, would claim a place
// KV does not keep to.
export const kvPlacementOf: KvPlacementOfFunction = ({ location, safeguard }, path) => {
  if (location === undefined && safeguard === undefined) return {};
  if (location !== "global" || safeguard === undefined) {
    throw runtimeText(
      new ConfigurationError(
        `${path} is kept in Workers KV, which keeps and caches what it holds anywhere in the world, in no jurisdiction: declare location: "global" together with the safeguard that allows that, both or neither`,
      ),
    );
  }
  return { location, safeguard };
};
