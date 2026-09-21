import { APP_MODULE_ID } from "./app-module.ts";
import type { Bounda } from "./create-bounda.ts";

const missing = (): never => {
  throw new Error(
    `${APP_MODULE_ID} is served by the bounda() Vite plugin. Add it to vite.config.ts: ` +
      'import { bounda } from "@bounda-dev/react-router/vite"; plugins: [bounda(), reactRouter()]',
  );
};

const provided: Bounda = missing();

/**
 * The context that holds the running app in loaders and actions: `context.get(bounda)`.
 * Served by the `bounda()` Vite plugin, typed for the project through `.bounda/register.d.ts`.
 */
export const bounda: Bounda["bounda"] = provided.bounda;

/**
 * The middleware to mount in `root.tsx`: `export const middleware = [boundaMiddleware]`.
 */
export const boundaMiddleware: Bounda["boundaMiddleware"] = provided.boundaMiddleware;

/**
 * Stops the running app and forgets it; the next request boots again.
 */
export const dispose: Bounda["dispose"] = provided.dispose;
