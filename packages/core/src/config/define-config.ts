import type { AppCollaboratorsConfig } from "../register/index.ts";
import type { Config } from "./types.ts";

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
 * `collaborators` section that names an aggregate or port the project does not have would pass.
 * This maps every unknown key to `never`, which the literal then fails to satisfy.
 */
export type WithExactCollaborators<C> = C extends { readonly collaborators: infer Given }
  ? { readonly collaborators: Exact<Given, AppCollaboratorsConfig> }
  : unknown;

export type DefineConfigFunction = <C extends Config>(config: C & WithExactCollaborators<C>) => C;

/**
 * Returns `config` as is, typed, so `bounda.config.ts` gets completion and compile-time checks
 * without importing `Config`. With the generated `register.d.ts` in the project, `collaborators`
 * only accepts the aggregates, ports and implementation names the generator found. Validation
 * happens at boot.
 */
export const defineConfig: DefineConfigFunction = (config) => config;
