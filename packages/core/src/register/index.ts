import type { PortsConfig } from "../config/types.ts";
import type { Registry } from "../modules/registry.ts";

/**
 * Where a project registers its registry type, the type of its `ports` configuration and
 * that of `createTestApp`'s `ports`. The generator writes `.bounda/register.d.ts`, which
 * augments this interface with the three:
 *
 * ```ts
 * declare module "@bounda-dev/core/register" {
 *   interface Register {
 *     readonly registry: typeof registry;
 *     readonly ports: PortsConfig;
 *     readonly testPorts: TestPorts;
 *   }
 * }
 * ```
 *
 * After that `BoundaApp`, `boot()` and the integrations are typed for the project without a type
 * argument, and `defineConfig` and `createTestApp` check their `ports` against the
 * project's ports.
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
 * The type of the `ports` section of the current project's configuration: the one
 * registered through {@link Register}, or the untyped `PortsConfig` when none is.
 */
export type AppPortsConfig = Register extends {
  readonly ports: infer C extends PortsConfig;
}
  ? C
  : PortsConfig;

/**
 * What a test app hands each port, by aggregate or read model and port: an implementation's file
 * name, built as the app would build it, or any other value, which the handlers receive as it is.
 */
export type TestPortsChoice = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * What `createTestApp` takes as `ports`, by aggregate or read model and port: an implementation's file
 * name or a double of the port. The one registered through {@link Register}, or untyped values
 * when none is.
 */
export type AppTestPorts = Register extends {
  readonly testPorts: infer C extends TestPortsChoice;
}
  ? C
  : TestPortsChoice;

/**
 * The environment an implementation's `create` receives: the one registered through
 * {@link Register}, or string variables by name, as `process.env` holds them, when none is.
 */
export type AppEnv = Register extends { readonly env: infer E }
  ? E
  : Readonly<Record<string, string | undefined>>;

interface OptionalEnv {
  /**
   * The host's environment, which every port implementation's `create` receives. Defaults
   * to an empty object.
   */
  readonly env?: AppEnv;
}

interface RequiredEnv {
  /**
   * The host's environment, which every port implementation's `create` receives.
   */
  readonly env: AppEnv;
}

type ModulesOf<C> =
  C extends Readonly<Record<string, Readonly<Record<string, infer M>>>> ? M : never;

type BuildsWithCreate<R extends Registry> = [
  Extract<
    | ModulesOf<NonNullable<R["aggregates"][keyof R["aggregates"]]["ports"]>>
    | ModulesOf<NonNullable<R["readModels"][keyof R["readModels"]]["ports"]>>,
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
    ? OptionalEnv
    : BuildsWithCreate<R> extends true
      ? RequiredEnv
      : OptionalEnv;
