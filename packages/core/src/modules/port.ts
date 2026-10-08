import type { Clock } from "../contracts/clock.ts";
import type { Logger } from "../contracts/logger.ts";
import type { AppEnv } from "../register/index.ts";

/**
 * What `create` receives: the host's environment, the app's logger and the app's clock.
 */
export interface CreateArgs {
  /**
   * The host's environment as it is: `process.env` after `.env` is loaded in Node, the Durable
   * Object's `env` on Cloudflare, what the test passes to `createTestApp`.
   */
  readonly env: AppEnv;
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
 * The shape of an implementation module of a port, `<aggregate>/infrastructure/<port>/<name>.ts`:
 * either a default export, which is what the aggregate's handlers receive as the port, or a
 * `create` export that builds it when the app starts, never both. The generated registry checks
 * every implementation against this with the port's interface, so one that does not fulfil it does
 * not compile.
 */
export type ImplementationModule<Port> =
  | { readonly default: Port; readonly create?: never }
  | { readonly create: CreateImplementation<Port>; readonly default?: never };

/**
 * The ports of one aggregate as the registry holds them: by port and then by
 * implementation file name, `ports.notifier.smtp`.
 */
export type PortModules = Readonly<
  Record<string, Readonly<Record<string, ImplementationModule<unknown>>>>
>;
