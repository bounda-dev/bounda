import type { Clock } from "../contracts/clock.ts";
import type { Logger } from "../contracts/logger.ts";
import type { AppEnv } from "../register/index.ts";

/**
 * What `create` receives: the host's environment, the name of the store the app serves, the app's
 * logger and the app's clock.
 */
export interface CreateArgs {
  /**
   * The host's environment as it is: `process.env` after `.env` is loaded in Node, the Durable
   * Object's `env` on Cloudflare, what the test passes to `createTestApp`.
   */
  readonly env: AppEnv;
  /**
   * The name of the store the app serves, for an implementation that differs by tenant (an
   * account or a key per customer): what `createApp` or `createTestApp` received as `tenant`,
   * which on Cloudflare is the name the Durable Object was addressed by with `idFromName`.
   * `undefined` for an app with one store, as under `boot()`, and for an object reached through an
   * id without a name.
   */
  readonly tenant?: string;
  readonly logger: Logger;
  readonly clock: Clock;
}

/**
 * Builds an implementation when the app starts, once per app instance. An implementation with
 * state (a client, a pool, a secret) exports one instead of a default, typed with the port it
 * builds: `export const create: CreateImplementation<Notifier> = ({ env }) => ...`. When what it
 * returns has `[Symbol.asyncDispose]`, `app.stop()` calls it.
 */
export interface CreateImplementation<Port> {
  (args: CreateArgs): Port | Promise<Port>;
}

/**
 * The shape of an implementation module of a port, `<module>/infrastructure/<port>/<name>.ts`:
 * either a default export, which is what the module's handlers receive as the port, or a
 * `create` export that builds it when the app starts, never both. The generated registry checks
 * every implementation against this with the port's interface, so one that does not fulfil it does
 * not compile.
 */
export type ImplementationModule<Port> =
  | { readonly default: Port; readonly create?: never }
  | { readonly create: CreateImplementation<Port>; readonly default?: never };

/**
 * The ports of one aggregate or read model as the registry holds them: by port and then by
 * implementation file name, `ports.notifier.smtp`.
 */
export type PortModules = Readonly<
  Record<string, Readonly<Record<string, ImplementationModule<unknown>>>>
>;
