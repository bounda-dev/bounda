import {
  type AppRegistry,
  type BoundaApp,
  type BoundaClient,
  type Consistency,
  checkConsistency,
  type Logger,
  type Registry,
  readYourWrites,
  resolveErrorText,
} from "@bounda-dev/core";
import type { ErrorText } from "@bounda-dev/core/config";
import { createContext, type MiddlewareFunction, type RouterContext } from "react-router";
import { type ActorFunction, actAs } from "./actor.ts";
import { createHandleError, type HandleBoundaErrorFunction } from "./handle-error.ts";
import { withIdempotencyKey } from "./idempotency-key.ts";

/**
 * Boots the app the middleware serves. Called on the first request, and again on the next one
 * after a failed boot or a `dispose`.
 */
export interface BootBoundaFunction<R extends Registry> {
  (): Promise<BoundaApp<R>>;
}

export interface CreateBoundaArgs<R extends Registry = AppRegistry> {
  /**
   * How to boot the app. Defaults to `boot()` from `@bounda-dev/core/node`, which reads
   * `bounda.config.ts` and `.bounda/registry.ts` from the working directory.
   */
  readonly boot?: BootBoundaFunction<R>;
  /**
   * Where the running app is kept on `globalThis`, so it survives a reload of the module that
   * calls `createBounda` in development. Calling it again under the same key stops the previous
   * app, and the next request boots a fresh one once that app has stopped. Defaults to
   * `"bounda.app"`; one app per key.
   */
  readonly key?: string;
  /**
   * What a loader sees right after an action dispatched a command. Defaults to
   * `"read-your-writes"`, so the page a redirect lands on already reflects it.
   */
  readonly consistency?: Consistency;
  /**
   * Who makes each request, which the client in its context acts as. Left out, requests act as
   * nobody.
   */
  readonly actor?: ActorFunction;
  /**
   * Where `handleError` logs. Defaults to `createConsoleLogger()` from `@bounda-dev/core/node`,
   * the logger `boot()` defaults to.
   */
  readonly logger?: Logger;
  /**
   * How `handleError` logs an error thrown while no app has booted, such as the boot's own
   * failure, unless `BOUNDA_ERROR_TEXT` says otherwise. Defaults to `"omit"`; once an app has
   * booted, `handleError` follows its `runtime.telemetry.errorText`.
   */
  readonly errorText?: ErrorText | undefined;
}

/**
 * A React Router middleware that boots the app on the first request, starts it and puts it in
 * the context of every request, acting as the request's `actor`, its commands carrying the
 * request's `Idempotency-Key` header, when it has one, as their `idempotencyKey`. Mount it in
 * `root.tsx`, after any middleware `actor` reads from: `export const middleware = [boundaMiddleware]`.
 */
export interface BoundaMiddleware {
  <Result>(...args: Parameters<MiddlewareFunction<Result>>): Promise<Result>;
}

/**
 * Stops the running app, if any, and forgets it, so the next request boots again. Resolves once
 * every app booted under the same key has stopped, including one a later `createBounda` is still
 * stopping.
 */
export interface DisposeBoundaFunction {
  (): Promise<void>;
}

export interface Bounda<R extends Registry = AppRegistry> {
  /**
   * The context that holds the app in loaders and actions: `context.get(bounda)`.
   */
  readonly bounda: RouterContext<BoundaClient<R>>;
  readonly boundaMiddleware: BoundaMiddleware;
  readonly dispose: DisposeBoundaFunction;
  readonly handleError: HandleBoundaErrorFunction;
}

export interface CreateBoundaFunction {
  <R extends Registry = AppRegistry>(args?: CreateBoundaArgs<R>): Bounda<R>;
}

interface Slot<R extends Registry> {
  app?: Promise<BoundaApp<R>> | undefined;
  retired?: Promise<void> | undefined;
  /**
   * The rule of the app `app` resolved to, read without waiting for a boot in flight.
   */
  errorText?: ErrorText | undefined;
}

const DEFAULT_KEY = "bounda.app";

const slotFor = <R extends Registry>(key: string): Slot<R> => {
  const store = globalThis as unknown as Record<symbol, Slot<R> | undefined>;
  const symbol = Symbol.for(key);
  const existing = store[symbol];
  if (existing !== undefined) return existing;
  const created: Slot<R> = {};
  store[symbol] = created;
  return created;
};

const started = <R extends Registry>(app: BoundaApp<R>): BoundaApp<R> => {
  app.start();
  return app;
};

const retire = <R extends Registry>(slot: Slot<R>): Promise<void> => {
  const running = slot.app;
  slot.app = undefined;
  slot.errorText = undefined;
  if (running === undefined && slot.retired === undefined) return Promise.resolve();
  const stopping = (slot.retired ?? Promise.resolve()).then(async () => {
    const app = await running?.catch(() => undefined);
    await app?.stop();
  });
  const retired = stopping
    .catch(() => undefined)
    .then(() => {
      if (slot.retired === retired) slot.retired = undefined;
    });
  slot.retired = retired;
  return stopping;
};

const load = <R extends Registry>(
  slot: Slot<R>,
  bootApp: BootBoundaFunction<R>,
  consistency: Consistency,
): Promise<BoundaApp<R>> => {
  if (slot.app !== undefined) return slot.app;
  const starting = (slot.retired === undefined ? bootApp() : slot.retired.then(() => bootApp()))
    .then(started)
    .then((app) => {
      if (slot.app === starting) slot.errorText = app.config.runtime.telemetry.errorText;
      return consistency === "read-your-writes" ? readYourWrites(app) : app;
    });
  slot.app = starting;
  starting.catch(() => {
    if (slot.app === starting) slot.app = undefined;
  });
  return starting;
};

/**
 * Wires Bounda into a React Router app: a context for the running app and the middleware that
 * boots it once and provides it to every loader and action. Declare it once in a server module,
 * mount the middleware in `root.tsx` and export `handleError` from `app/entry.server.tsx`, which
 * logs what a request throws as the app's `runtime.telemetry.errorText` says. By default a command resolves once the read models
 * reflect it (see `consistency`). When the server module is re-evaluated in development, the next
 * request boots from the new modules only once the previous app has stopped, so the two never
 * hold the storage at once. Throws `ConfigurationError` for a `consistency` it does not know.
 *
 * @example
 * // app/bounda.server.ts
 * export const { bounda, boundaMiddleware, handleError } = createBounda({
 *   boot: () => boot({ registry }),
 * });
 *
 * // app/root.tsx
 * export const middleware = [boundaMiddleware];
 *
 * // app/entry.server.tsx
 * export { handleError } from "./bounda.server.ts";
 *
 * // app/routes/user.tsx
 * export const action = ({ params, context }: Route.ActionArgs) =>
 *   context.get(bounda).commands.activateUser({ userId: params.userId });
 */
export const createBounda: CreateBoundaFunction = <R extends Registry = AppRegistry>({
  // Imported on demand, so that importing this package does not load Node's modules on Cloudflare.
  boot: bootApp = async () => (await import("@bounda-dev/core/node")).boot<R>(),
  key = DEFAULT_KEY,
  consistency = "read-your-writes",
  actor,
  logger,
  errorText = "omit",
}: CreateBoundaArgs<R> = {}): Bounda<R> => {
  checkConsistency(consistency);
  const bounda = createContext<BoundaClient<R>>();
  const slot = slotFor<R>(key);
  void retire(slot);
  let consoleLogger: Promise<Logger> | undefined;

  const boundaMiddleware: BoundaMiddleware = async (args, next) => {
    const client = await actAs(await load(slot, bootApp, consistency), actor, args);
    args.context.set(bounda, await withIdempotencyKey(client, args.request));
    return next();
  };

  const dispose: DisposeBoundaFunction = () => retire(slot);

  const handleError = createHandleError({
    message: "request failed",
    // Before any app has booted, what `boot()` would resolve without the configuration.
    errorText: () =>
      slot.errorText ??
      resolveErrorText({ env: globalThis.process?.env, fallback: errorText, invalidEnv: "ignore" }),
    logger: () => {
      if (logger !== undefined) return logger;
      consoleLogger ??= import("@bounda-dev/core/node").then((node) => node.createConsoleLogger());
      return consoleLogger;
    },
  });

  return { bounda, boundaMiddleware, dispose, handleError };
};
