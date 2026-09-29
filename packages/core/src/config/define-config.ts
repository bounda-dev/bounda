import type { Config } from "./types.ts";

export type DefineConfigFunction = <C extends Config>(config: C) => C;

/**
 * Returns `config` as is, typed, so `bounda.config.ts` gets completion and compile-time checks
 * without importing `Config`. Validation happens at boot.
 */
export const defineConfig: DefineConfigFunction = (config) => config;
