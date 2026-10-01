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
