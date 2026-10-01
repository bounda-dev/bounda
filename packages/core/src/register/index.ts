import type { CollaboratorsConfig } from "../config/types.ts";
import type { Registry } from "../modules/registry.ts";

/**
 * Where a project registers its registry type and the type of its `collaborators` configuration.
 * The generator writes `.bounda/register.d.ts`, which augments this interface with both:
 *
 * ```ts
 * declare module "@bounda-dev/core/register" {
 *   interface Register {
 *     readonly registry: typeof registry;
 *     readonly collaborators: CollaboratorsConfig;
 *   }
 * }
 * ```
 *
 * After that `BoundaApp`, `boot()` and the integrations are typed for the project without a type
 * argument, and `defineConfig` checks the `collaborators` section against the project's ports.
 * A host adapter may register `env`, the type of the environment implementations receive in
 * `create`: `@bounda-dev/adapter-cloudflare` registers `Cloudflare.Env`.
 */
export interface Register {}

/**
 * The registry type of the current project: the one registered through {@link Register}, or the
 * untyped `Registry` when none is.
 */
export type AppRegistry = Register extends { readonly registry: infer R extends Registry }
  ? R
  : Registry;

/**
 * The type of the `collaborators` section of the current project's configuration: the one
 * registered through {@link Register}, or the untyped `CollaboratorsConfig` when none is.
 */
export type AppCollaboratorsConfig = Register extends {
  readonly collaborators: infer C extends CollaboratorsConfig;
}
  ? C
  : CollaboratorsConfig;

/**
 * The environment an implementation's `create` receives: the one registered through
 * {@link Register}, or string variables by name, as `process.env` holds them, when none is.
 */
export type AppEnv = Register extends { readonly env: infer E }
  ? E
  : Readonly<Record<string, string | undefined>>;

type ModulesOf<C> =
  C extends Readonly<Record<string, Readonly<Record<string, infer M>>>> ? M : never;

type BuildsWithCreate<R extends Registry> = [
  Extract<
    ModulesOf<NonNullable<R["aggregates"][keyof R["aggregates"]]["collaborators"]>>,
    { readonly create: unknown }
  >,
] extends [never]
  ? false
  : true;

/**
 * The `env` option of `createApp` and `createTestApp`: required when a host registers an
 * environment an empty object does not satisfy, such as `Cloudflare.Env`, and some implementation
 * of the registry exports `create`, which would receive it; optional otherwise, an empty object by
 * default.
 */
export type EnvSection<R extends Registry = Registry> =
  Record<never, never> extends AppEnv
    ? { readonly env?: AppEnv }
    : BuildsWithCreate<R> extends true
      ? { readonly env: AppEnv }
      : { readonly env?: AppEnv };
