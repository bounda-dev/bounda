import type { AppPortsConfig } from "../register/index.ts";
import type { Config, ProjectConfig, TenantConfigArgs } from "./types.ts";

type Exact<Actual, Expected> = Actual extends Expected
  ? Expected extends object
    ? {
        [Key in keyof Actual]: Key extends keyof Expected
          ? Exact<Actual[Key], Expected[Key]>
          : never;
      }
    : Actual
  : Expected;

/**
 * A generic argument is not checked for excess properties below its top level, so a
 * `ports` section that names an aggregate or port the project does not have would pass.
 * This maps every unknown key to `never`, which the literal then fails to satisfy.
 */
export type WithExactPorts<C> = C extends { readonly ports: infer Given }
  ? { readonly ports: Exact<Given, AppPortsConfig> }
  : unknown;

// The function first: a configuration object that fails both is then reported on the property at
// fault, as the object's own signature is the last one tried.
export interface DefineConfigFunction {
  <C extends Config>(
    config: (args: TenantConfigArgs) => C & WithExactPorts<C>,
  ): (args: TenantConfigArgs) => C;
  <C extends Config>(config: C & WithExactPorts<C>): C;
}

/**
 * Returns `config` as is, typed, so `bounda.config.ts` gets completion and compile-time checks
 * without importing `Config`. With the generated `register.d.ts` in the project, `ports`
 * only accepts the aggregates, ports and implementation names the generator found. Validation
 * happens at boot.
 *
 * A function of the tenant instead serves several tenants from one project, each its own
 * database: `boot()`, the CLI and the React Router host call it with the tenant they serve, as in
 * `({ tenant }) => ({ storage: postgresql({ url, schema: tenant }) })`.
 */
export const defineConfig: DefineConfigFunction = <C extends Config>(
  config: C | ((args: TenantConfigArgs) => C),
) => config as never;

export interface ConfigForTenantArgs {
  /**
   * What `bounda.config.ts` exports: a configuration, or a function of the tenant.
   */
  readonly config: ProjectConfig;
  readonly tenant: string;
}

export interface ConfigForTenantFunction {
  (args: ConfigForTenantArgs): Config;
}

/**
 * The configuration of one tenant: the project's own, or what its function gives for the tenant.
 */
export const configForTenant: ConfigForTenantFunction = ({ config, tenant }) =>
  typeof config === "function" ? config({ tenant }) : config;
