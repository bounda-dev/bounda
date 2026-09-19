import type { Config } from "./types.ts";

export type DefineConfigFunction = <C extends Config>(config: C) => C;

/**
 * Types and returns the configuration object. Validation happens at boot through `resolveConfig`;
 * this function exists so `bounda.config.ts` gets completion and compile-time checks without an
 * import of the `Config` type.
 */
export const defineConfig: DefineConfigFunction = (config) => config;
