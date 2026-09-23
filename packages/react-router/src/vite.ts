import { systemClock } from "@bounda-dev/core";
import type { Plugin } from "vite";
import type { Consistency } from "./create-bounda.ts";
import { createBoundaPlugin } from "./vite-plugin.ts";

export interface BoundaVitePluginOptions {
  /**
   * Passed to `createBounda`. Defaults to `"immediate"`: the app in the context reads its own
   * writes.
   */
  readonly consistency?: Consistency;
  /**
   * Quiet time after the last change under `domain/` or `read/` before regenerating. Defaults to
   * 100 ms.
   */
  readonly debounceMs?: number;
}

export interface BoundaVitePluginFunction {
  (options?: BoundaVitePluginOptions): Plugin;
}

/**
 * Runs `bounda generate` inside Vite and serves `@bounda-dev/react-router/app`: the project's
 * `bounda` context, `boundaMiddleware` and `dispose`, wired to the generated registry. The
 * registry is imported by value, so a change under `app/domain` or `app/read` regenerates the
 * types, re-evaluates the module and reboots the app on the next request. The client build gets
 * a stub that fails loudly if a component touches it. When the dev server closes, it waits for a
 * regeneration in flight rather than letting it write after the server has gone.
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
