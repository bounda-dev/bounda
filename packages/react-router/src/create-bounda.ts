import { type AppRegistry, type BoundaApp, type Registry, readYourWrites } from "@bounda-dev/core";
import { boot } from "@bounda-dev/core/node";
import { createContext, type MiddlewareFunction, type RouterContext } from "react-router";

/**
 * Boots the app the middleware serves. Called once per process, on the first request.
 */
export interface BootBoundaFunction<R extends Registry> {
  (): Promise<BoundaApp<R>>;
}

/**
 * What a loader sees right after an action dispatched a command. `immediate` (the default) brings
 * the read models up to date before the command resolves, so the page a redirect lands on already
 * reflects it. `eventual` leaves projections to the background and reads may lag behind.
 */
export type Consistency = "immediate" | "eventual";

export interface CreateBoundaArgs<R extends Registry = AppRegistry> {
  /**
   * How to boot the app. Defaults to `boot()` from `@bounda-dev/core/node`, which reads
   * `bounda.config.ts` and `.bounda/registry.ts` from the working directory.
   */
  readonly boot?: BootBoundaFunction<R>;
  /**
   * The key under which the running app is kept on `globalThis`, so that it survives a reload of
   * the module that called `createBounda` in development. Calling `createBounda` again with the
   * same key stops the app booted by the previous call; the next request boots a fresh one from
   * the reloaded modules once that app has stopped. Defaults to `"bounda.app"`; one app per key.
   */
  readonly key?: string;
  readonly consistency?: Consistency;
}

/**
 * A React Router middleware that boots the app on the first request, starts it and puts it in
 * the context of every request. Return it from `middleware` in `root.tsx`.
 */
export interface BoundaMiddleware {
  <Result>(...args: Parameters<MiddlewareFunction<Result>>): Promise<Result>;
}

/**
 * Stops the running app, if any, and forgets it, so that the next request boots again. Resolves
 * once every app booted under the same key has stopped, including one that a later call to
 * `createBounda` is still stopping.
 */
export interface DisposeBoundaFunction {
  (): Promise<void>;
}

export interface Bounda<R extends Registry = AppRegistry> {
  /**
   * The context that holds the app in loaders and actions: `context.get(bounda)`.
   */
  readonly bounda: RouterContext<BoundaApp<R>>;
  readonly boundaMiddleware: BoundaMiddleware;
  readonly dispose: DisposeBoundaFunction;
}

export interface CreateBoundaFunction {
  <R extends Registry = AppRegistry>(args?: CreateBoundaArgs<R>): Bounda<R>;
}

interface Slot<R extends Registry> {
  app?: Promise<BoundaApp<R>> | undefined;
  retired?: Promise<void> | undefined;
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
    .then((app) => (consistency === "immediate" ? readYourWrites(app) : app));
  slot.app = starting;
  starting.catch(() => {
    if (slot.app === starting) slot.app = undefined;
  });
  return starting;
};

/**
 * Wires Bounda into a React Router app: a context for the running app and the middleware that
 * boots it once and provides it to every loader and action. By default the app in the context
 * reads its own writes: a command resolves once the read models reflect it, so the page a redirect
 * lands on is fresh. Declare it once in a server module and mount the middleware in `root.tsx`.
 * In development the server
 * module is re-evaluated when the code changes; the app booted before is stopped and the next
 * request boots one from the new modules once it has, so the two never hold the storage at once.
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
export const createBounda: CreateBoundaFunction = <R extends Registry = AppRegistry>({
  boot: bootApp = () => boot<R>(),
  key = DEFAULT_KEY,
  consistency = "immediate",
}: CreateBoundaArgs<R> = {}): Bounda<R> => {
  const bounda = createContext<BoundaApp<R>>();
  const slot = slotFor<R>(key);
  void retire(slot);

  const boundaMiddleware: BoundaMiddleware = async ({ context }, next) => {
    context.set(bounda, await load(slot, bootApp, consistency));
    return next();
  };

  const dispose: DisposeBoundaFunction = () => retire(slot);

  return { bounda, boundaMiddleware, dispose };
};
