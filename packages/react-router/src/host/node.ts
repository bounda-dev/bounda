import { type AppRegistry, ConfigurationError, type Registry } from "@bounda-dev/core";
import { boot, type ImportModuleFunction } from "@bounda-dev/core/node";
import { type Bounda, createBounda } from "../create-bounda.ts";
import type { CreateHostArgs, CreateHostFunction } from "./args.ts";

export { failure } from "../failure.ts";
export type { CreateHostArgs, CreateHostFunction } from "./args.ts";

// What Node says when `bounda.config.ts` imports `@bounda-dev/cloudflare`.
const needsWorkers = (error: unknown): boolean =>
  error instanceof Error &&
  Reflect.get(error, "code") === "ERR_UNSUPPORTED_ESM_URL_SCHEME" &&
  error.message.includes("'cloudflare:'");

const explainWorkers =
  (importConfig: ImportModuleFunction): ImportModuleFunction =>
  async () => {
    try {
      return await importConfig();
    } catch (error) {
      if (!needsWorkers(error)) throw error;
      throw new ConfigurationError(
        'bounda.config.ts imports the Workers runtime, as cloudflare() does, so React Router has to run in the Worker: add cloudflare({ viteEnvironment: { name: "ssr" } }) from @cloudflare/vite-plugin to the plugins in vite.config.ts',
        { cause: error },
      );
    }
  };

/**
 * The host the `bounda()` Vite plugin serves the app from: in Node, `createBounda` booting the
 * project; under the `workerd` condition, the one of `@bounda-dev/react-router/cloudflare`. Not
 * meant to be called by hand: call either `createBounda` instead. In Node the boot rejects with
 * `ConfigurationError` when the configuration needs the Workers runtime, as `cloudflare()` does;
 * otherwise it throws as `createBounda` does.
 */
export const createHost: CreateHostFunction = <R extends Registry = AppRegistry>({
  root,
  registry,
  importConfig,
  consistency,
}: CreateHostArgs<R>): Bounda<R> =>
  createBounda<R>({
    boot: () =>
      boot<R>({
        ...(root === undefined ? {} : { root }),
        registry,
        importConfig: explainWorkers(importConfig),
      }),
    consistency,
  });
