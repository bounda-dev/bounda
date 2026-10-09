import { type Consistency, systemClock } from "@bounda-dev/core";
import type { Plugin } from "vite";
import { createBoundaPlugin } from "./vite-plugin.ts";

export interface BoundaVitePluginOptions {
  /**
   * Passed to `createBounda`. Defaults to `"read-your-writes"`.
   */
  readonly consistency?: Consistency;
  /**
   * Quiet time after the last change under `app/domain` or `app/read` before regenerating.
   * Defaults to 100 ms.
   */
  readonly debounceMs?: number;
}

export interface BoundaVitePluginFunction {
  (options?: BoundaVitePluginOptions): Plugin;
}

/**
 * Runs `bounda generate` inside Vite and serves `@bounda-dev/react-router/app`: the project's
 * `bounda` context, `boundaMiddleware` and `dispose`, wired to the generated registry and to
 * `bounda.config.ts`. A change under `app/domain` or `app/read`, or to the configuration,
 * regenerates the project where needed and reboots the app on the next request. A build bundles
 * the registry and the configuration, and reads `.env` from the directory it runs in. A convention error fails `vite build` and is only logged by the dev server. In the
 * client the module throws as soon as a component touches it.
 *
 * @example
 * // vite.config.ts
 * import { bounda } from "@bounda-dev/react-router/vite";
 * import { reactRouter } from "@react-router/dev/vite";
 *
 * export default defineConfig({ plugins: [bounda(), reactRouter()] });
 */
export const bounda: BoundaVitePluginFunction = (options = {}) =>
  createBoundaPlugin({ ...options, clock: systemClock });
