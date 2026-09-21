import type { BoundaApp, Registry } from "@bounda-dev/core";
import { boot } from "@bounda-dev/core/node";
import { createContext, type MiddlewareFunction, type RouterContext } from "react-router";

/**
 * Boots the app the middleware serves. Called once per process, on the first request.
 */
export interface BootBoundaFunction<R extends Registry> {
  (): Promise<BoundaApp<R>>;
}

export interface CreateBoundaArgs<R extends Registry> {
  /**
   * How to boot the app. Defaults to `boot()` from `@bounda-dev/core/node`, which reads
   * `bounda.config.ts` and `.bounda/registry.ts` from the working directory.
   */
  readonly boot?: BootBoundaFunction<R>;
  /**
   * The key under which the running app is kept on `globalThis`, so that it survives a reload of
   * the module that called `createBounda` in development. Calling `createBounda` again with the
   * same key stops the app booted by the previous call; the next request boots a fresh one from
   * the reloaded modules. Defaults to `"bounda.app"`; one app per key.
   */
  readonly key?: string;
}

/**
 * A React Router middleware that boots the app on the first request, starts it and puts it in
 * the context of every request. Return it from `middleware` in `root.tsx`.
 */
export interface BoundaMiddleware {
  <Result>(...args: Parameters<MiddlewareFunction<Result>>): Promise<Result>;
}

/**
 * Stops the running app, if any, and forgets it, so that the next request boots again.
 */
export interface DisposeBoundaFunction {
  (): Promise<void>;
}

export interface Bounda<R extends Registry> {
  /**
   * The context that holds the app in loaders and actions: `context.get(bounda)`.
   */
  readonly bounda: RouterContext<BoundaApp<R>>;
  readonly boundaMiddleware: BoundaMiddleware;
  readonly dispose: DisposeBoundaFunction;
}

export interface CreateBoundaFunction {
  <R extends Registry>(args?: CreateBoundaArgs<R>): Bounda<R>;
}

interface Slot<R extends Registry> {
  app?: Promise<BoundaApp<R>> | undefined;
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

const stop = async <R extends Registry>(slot: Slot<R>): Promise<void> => {
  const running = slot.app;
  slot.app = undefined;
  if (running === undefined) return;
  const app = await running.catch(() => undefined);
  await app?.stop();
};

const load = <R extends Registry>(
  slot: Slot<R>,
  bootApp: BootBoundaFunction<R>,
): Promise<BoundaApp<R>> => {
  if (slot.app !== undefined) return slot.app;
  const starting = bootApp().then(started);
  slot.app = starting;
  starting.catch(() => {
    if (slot.app === starting) slot.app = undefined;
  });
  return starting;
};

/**
 * Wires Bounda into a React Router app: a context for the running app and the middleware that
 * boots it once and provides it to every loader and action. Declare it once in a server module
 * with the registry's type, and mount the middleware in `root.tsx`. In development the server
 * module is re-evaluated when the code changes; the app booted before is stopped and the next
 * request boots one from the new modules.
 *
 * @example
 * // app/bounda.server.ts
 * export const { bounda, boundaMiddleware } = createBounda({ boot: () => boot({ registry }) });
 *
 * // app/root.tsx
 * export const middleware = [boundaMiddleware];
 *
 * // app/routes/register.tsx
 * export const action = async ({ request, context }: Route.ActionArgs) =>
 *   context.get(bounda).commands.registerUser(await payloadOf(request));
 */
export const createBounda: CreateBoundaFunction = <R extends Registry>({
  boot: bootApp = () => boot<R>(),
  key = DEFAULT_KEY,
}: CreateBoundaArgs<R> = {}): Bounda<R> => {
  const bounda = createContext<BoundaApp<R>>();
  const slot = slotFor<R>(key);
  void stop(slot);

  const boundaMiddleware: BoundaMiddleware = async ({ context }, next) => {
    context.set(bounda, await load(slot, bootApp));
    return next();
  };

  const dispose: DisposeBoundaFunction = () => stop(slot);

  return { bounda, boundaMiddleware, dispose };
};
