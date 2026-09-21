import type { Registry } from "../modules/registry.ts";

/**
 * Where a project registers its registry type. The generator writes `.bounda/register.d.ts`,
 * which augments this interface with the project's registry:
 *
 * ```ts
 * declare module "@bounda-dev/core/register" {
 *   interface Register {
 *     readonly registry: typeof registry;
 *   }
 * }
 * ```
 *
 * After that `BoundaApp`, `boot()` and the integrations are typed for the project without a type
 * argument.
 */
export interface Register {}

/**
 * The registry type of the current project: the one registered through {@link Register}, or the
 * untyped `Registry` when none is.
 */
export type AppRegistry = Register extends { readonly registry: infer R extends Registry }
  ? R
  : Registry;
